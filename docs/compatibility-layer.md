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

## Explorer pre-fetch

The pre-fetch runs for a subagent child that reads only: it declares the native `codegraph` tool, the MCP
`mcp__codegraph__codegraph_explore` tool, or both, and declares no command tool and no file-writing tool. The query
is the sanitized first 300 characters of the task; the answer comes from the daemon of the child's own checkout;
the output is bounded to 12 000 characters and the daemon call to 10 s. With no daemon, nothing is added at once
and a background warm-up starts for the next explorer. Nothing about it can fail the run.

## Role rules

The child's role is read from the tool list gentle-pi requested for it (a subagent child carries no agent name):

| Declared tools | Role | May start an index write? |
| --- | --- | --- |
| a file-writing tool (`edit`, `write`, `bash_background`) | writer (worker) | yes |
| a command tool (`bash`), no file-writing tool | read-only (verify, the judges) | **no** |
| no command tool, a CodeGraph tool | explorer | yes |
| nothing recognisable | unknown | yes (behaves as before) |

The main session is not a subagent role and is never narrowed. A read-only role starts no `init` and no `sync` in
any directory, is never pre-fetched for, and no agent file is edited: gentle-shell ships the exploring MCP tool to
that role and never the native tool, which can `init`. Navigation is not proof: a CodeGraph answer says what the index held when it was
read, so results are treated as hints to verify against source, and no notice calls an unconfirmed index current.

## What the tests pin

`test/index-coordination.test.ts`, `test/init-hook.test.ts`, `test/daemonclient.test.ts`, `test/warmup.test.ts`,
`test/prefetch.test.ts`, `test/agents.test.ts`, `test/apply.test.ts`, `test/child-index.test.ts` and
`test/index-notice.test.ts` cover: the create-or-sync decision, the coordinated/unavailable/pending paths, all
post-init outcomes including the no-sync-after-failure rule, daemon resolution per checkout with and without MCP
configuration, explorer detection through the native tool and through MCP, a worktree versus its parent checkout,
the read-only role rule, and the two read-only `mcp.json` warnings (missing server, unavailable exposure). No test
spawns a real `codegraph`, `git` or network call; runners are injected and scratch state lives under the system temp
directory.
