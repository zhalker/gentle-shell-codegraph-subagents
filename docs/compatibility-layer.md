# The CodeGraph compatibility layer

This package is the compatibility layer between gentle-shell (through gentle-pi), Pi's extension API and the
CodeGraph CLI. gentle-shell itself is not modified: no edits to its source, no new model-facing tool, no override of
a tool of the same name, and no dependency on extension load order.

The contract below is what the code in this repository actually does. Where a rule cannot be met, the case says so
in plain words instead of being left to guesswork.

## What the package does and does not do

| It does | It does not |
| --- | --- |
| Observe a native `codegraph init` call and append one coordinated sync's outcome to its result | Register a `codegraph` tool, wrap it, shadow it, or assume any extension loads first |
| Prepare the index of the checkout a session acts on (create or sync) | Index a directory it was not pointed at, or use a parent checkout's index or daemon for a worktree |
| Resolve the daemon of that checkout, reusing a live registered one | Treat an MCP server entry as evidence that a daemon is reachable, rewrite `mcp.json`, or kill a daemon it did not start |
| Report `completed`, `pending`, `skipped`, `failed` honestly in notices and logs | Call a queued, joined, coalesced or failed request a synced index |
| Keep verify and the judges out of every index write | Edit an agent file, strip a tool a user added, or add the native tool to a read-only role |
| Append the CodeGraph rule to the system prompt of every session that can call CodeGraph | Ship a skill, edit an agent file, or replace the harness's system prompt |

Agent files and `mcp.json` are never written. gentle-shell ships `mcp__codegraph__codegraph_explore` in the
explorer, verifier, worker, fix agent and both judges itself, so there is nothing to patch; the extension reads
`mcp.json` only to warn when the shipped tool is not visible. The frozen normalizers in `src/legacy-agents.ts` are
used to recognise a file an older version wrote, never to write one, and the repair only renames a file back to
gentle-pi.

## Index preparation: create or sync, always coordinated

The decision per directory, in order, is one policy (`planIndexAction`, extended by `worktreeIndexAction`):

1. `.codegraph` exists → one quiet `codegraph sync`.
2. A linked git worktree without an index whose main checkout has one → seed from the main checkout's
   `codegraph.db` (only while nobody is writing it), then one `codegraph sync` of the worktree.
3. A fresh git project with a known manifest (`package.json`, `composer.json`, `pyproject.toml`, `go.mod`,
   `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle`, `build.gradle.kts`) → `codegraph init -y`.
4. Anything else → nothing is created.

Every write of that policy goes through the package's coordination:

- **The index lock** (`src/initlock.ts`) orders every index writer of one project, across the Pi sessions of one
  user: an `init` and a `sync` never overlap, a sync holds it for its whole run and records the `codegraph` process
  it started, and CodeGraph's own `.codegraph/codegraph.lock` is consulted for a writer this package did not start.
- **The sync lease** (`src/compaction-sync.ts`) orders the package's own syncs. A request that arrives during
  another sync is recorded on disk and served by one follow-up run of the session that is syncing; it is marked as
  served only after a run that started after it has finished.
- **Fail closed.** When the lease state cannot be created, read or gated, no sync starts and the request is
  reported as `unavailable` (`skipped-coordination-unavailable` in `sync.log`). A sync is never started beside the
  coordination as a fallback.
- **Reported, not dropped.** A request that has not run yet is `queued`/`pending` and stays on disk. A request that
  could not be coordinated is a warning that says no sync was started.
- **Session-wide worktree seeding** takes each worktree's own index lock before copying the main checkout's db into
  it, re-takes the decision under that lock, and skips a worktree another session is writing (recorded in
  `sync.log` as `seed-skipped: …`). The main checkout is never seeded from itself.

Startup, worktree seeding (per checkout, per session and on gentle-pi's worktree event), compaction and the
post-`init` hook all share this coordination. Subagent children do nothing except in a worktree they were handed,
and a read-only role does nothing anywhere.

## A native `codegraph init` is observed

Pi's `tool_result` event fires after a tool ran and before its final result message; a handler may return a partial
patch of `content`, and Pi keeps every field it does not receive. A handler that throws is caught by Pi
(`dist/core/extensions/runner.js`, `emitToolResult`) and only emits an extension error, so the hook cannot make the
tool call fail. That is the mechanism this package uses, and no API is invented around it.

After a **successful native** `codegraph init` (`toolName === "codegraph"`, `input.operation === "init"`,
`isError === false`), the package requests exactly one coordinated sync of the session's checkout and appends one
line to the tool's result:

- `completed` — a coordinated run came back (or another session's run that started after this request completed);
- `pending` — the request is recorded and has not run yet; the index is explicitly **not confirmed current**;
- `failed` — the run failed, or no index was found after the init; the index may be behind;
- `unavailable` — the coordination state was unusable, so no sync started.

A **failed** init keeps its original error and triggers no sync, and nothing is appended to it. A read-only role
gets no sync at all (see below). The tool result waits at most 10 s for its answer; the request itself keeps going
and its final outcome is appended to `~/.pi/agent/codegraph-subagents/sync.log` as `init-sync-<outcome>`.

Limits of the observation: it sees the native `codegraph` tool only. `codegraph init` typed into `bash`, run from a
terminal, by a git hook or by another tool is not observed and not coordinated by this package.

## Daemon per checkout, MCP optional

- `exploreViaDaemon` and `liveDaemon`/`daemonStatus` read the CodeGraph daemon registry
  (`~/.codegraph/daemons/`) and match the **one** root they were given, in its canonical spelling. A worktree is its
  own root with its own index and its own daemon; the parent's daemon is never used for a child's checkout.
- A record is live only while its process runs and its socket is still present; a dead record never wins.
- The warm-up reuses a live registered daemon of that checkout — one read through it is the warm-up — and only
  spawns `codegraph serve --mcp` when there is none. A live daemon that does not answer is not doubled by a second
  server. Nothing here stops a daemon, because the daemon is shared with the user's own sessions.
- MCP availability is independent: the daemon status comes from the registry alone, an MCP entry does not start or
  prove a daemon, and the package never rewrites `mcp.json`. A missing MCP server is still reported at startup,
  because it decides whether the subagents can call the tool directly — not whether a daemon is up.

## Role rules

The child's role is read from the tool list gentle-pi requested for it (a subagent child carries no agent name):

| Declared tools | Role | May start an index write? |
| --- | --- | --- |
| a file-writing tool (`edit`, `write`, `bash_background`) | writer (worker) | yes |
| a command tool (`bash`), no file-writing tool | read-only (verify, the judges) | **no** |
| no command tool, a CodeGraph tool | explorer | yes |
| nothing recognisable | unknown | yes (behaves as before) |

The main session is not a subagent role and is never narrowed. A read-only role starts no `init` and no `sync` in
any directory, and no agent file is edited: gentle-shell ships the exploring MCP tool to
that role and never the native tool, which can `init`. Navigation is not proof: a CodeGraph answer says what the index held when it was
read, so results are treated as hints to verify against source, and no notice calls an unconfirmed index current.

## The CodeGraph rule in the system prompt

The approved wording lives in `src/codegraph-rules/`, one Markdown file per role, and the code reads the text of the
session's own role from disk. Nothing is reworded in code, so the text stays reviewable and editable as prose, and a
role that does not need the `init` guidance does not carry it.

| Session | Text |
| --- | --- |
| the primary session (no `GENTLE_PI_AGENTS_CHILD=1`) | `orchestrator.md` |
| `gentle-ai-explore` | `explore.md` |
| `gentle-ai-verify` | `verify.md` |
| `gentle-ai-worker` | `worker.md` |
| `jd-fix-agent` | `fix.md` |
| `jd-judge-a`, `jd-judge-b` | `judge.md` |
| any other child, a name that is not recognised, or a text that cannot be read | `generic.md` |

The agent name is read from the child's own command line, where gentle-pi passes its agent body as
`<tmpdir>/gentle-pi-subagent-<agent>-<random>/instructions.md`; no environment variable carries it. A name the table
does not carry is kept as the directory spells it, so a `review-` child is still recognised by its prefix.

The texts follow gentle-shell's own allowlists: the native `codegraph` tool (which can `init`, `query` and `explore`)
is granted to the orchestrator and the explorer, while the worker, the fix agent, the verifier and both judges hold
`mcp__codegraph__codegraph_explore` alone, named in full wherever a text names it. No text tells an agent to create or
refresh an index: that is the extension's job at session start, so a session without one is told to fall back to
`read`, `grep` and `find`, and verify and the judges are told that the index they read is left alone.

A text is the role's addition to its own agent file, not a replacement for it: the explorer's base file already states
the gate, the fallback and the index rules, so `explore.md` carries only the delta over it. Only `generic.md` names
both tool shapes, because it serves a child whose tools are not known.

Each file is read at most once per variant, and a read never throws. A missing, unreadable or heading-less file falls
back to `generic.md`, and when that cannot be read either the session gets no section rather than a broken prompt.

It is injected by `before_agent_start`, by mutating `event.systemPromptOptions.appendSystemPrompt` in place:

- Append-only. Every byte the harness wrote stays the prefix of the new value, and no handler returns a replacement
  `systemPrompt`.
- Idempotent by its `## CodeGraph` heading. A session that already carries the section is left alone.
- Gated on the session's tools. The selected tools are read, plus the tool list gentle-pi requested for a subagent
  child (its MCP tools are not selected yet when the hook runs). A session holding neither the native `codegraph`
  tool nor `mcp__codegraph__codegraph_explore` gets nothing, which is how a reviewer stays out; so does an agent
  whose name starts with `review-`, even when it holds the tool.
- The index fact lives inside the section. When `.codegraph/codegraph.db` is found at or above the session's
  directory, one line says the workspace has an index; there is no separate first-prompt notice, no message
  renderer and no message to re-send after a compaction.
- Non-throwing. A missing event, missing options or a non-string append field is left alone, so the prompt keeps
  exactly what the harness wrote.

There is no exploration reminder. The rule permits a session with no CodeGraph call — an exact-string or filename
lookup, a known file that needs no structural investigation, a run that only executes commands or tests — so a nudge
fired on the first search would report a fault the rule allows.

## What the tests pin

`test/index-coordination.test.ts`, `test/init-hook.test.ts`, `test/daemonclient.test.ts`, `test/warmup.test.ts`,
`test/agents.test.ts`, `test/apply.test.ts`, `test/child-index.test.ts`, `test/index-notice.test.ts`,
`test/codegraph-rules.test.ts` and `test/skill-package.test.ts` cover: the
create-or-sync decision, the coordinated/unavailable/pending paths, all post-init outcomes including the
no-sync-after-failure rule, daemon resolution per checkout with and without MCP configuration, explorer detection
through the native tool and through MCP, a worktree versus its parent checkout, the read-only role rule, the two
read-only `mcp.json` warnings (missing server, unavailable exposure), the agent name read from a child's own argv and
the six role mappings, the primary and generic cases, the exact text of every shipped file and its per-file read
cache, the facts that no text offers an `init` operation and that the MCP tool is named in full, the role whose text
is the delta over its agent file, the generic fallback of a
missing or heading-less file, the tool and `review-` gates, append/idempotency and
the index line, the absence of the exploration reminder, and the absence of a
packaged skill. No test spawns a real `codegraph`, `git` or network call; runners are injected and scratch state
lives under the system temp directory.
