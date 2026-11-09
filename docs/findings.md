# Findings behind the plan (verified 2026-11-03, Windows, Pi 1.5.0, gentle-pi 4.5.1, gentle-ai 4.3.1, CodeGraph 1.6.0)

Everything below was observed by reading the installed code and by running real subagents. Nothing here is a spec; the specs live in `odd/tasks/codegraph-subagents.md`.

## How a subagent gets its tools

- Agent definitions are Markdown files with frontmatter: global in `~/.pi/agent/agents/` and `~/.pi/agent/subagents/`, per project in `<project>/.pi/agents/` and `<project>/.pi/subagents/`. A later directory replaces an earlier definition with the same name; there is no merge (`gentle-pi/lib/agents-config.ts`, `agentDirectories`).
- `tools:` becomes the child's `--tools a,b,c` allowlist (`gentle-pi/lib/agents-runner.ts`, `requestedTools`). An empty list means Pi's default tools. The runner always adds `subagent_parent_message`.
- Frontmatter parsing is minimal: `key: a, b`, `key: [a, b]`, or a `-` list (`parseFrontmatter`).
- Extensions installed globally (`~/.pi/agent/extensions/`, or a package in `settings.json`) load in the children. The tool is visible only if its name is in the agent's `tools:`. Control: `gentle-ai-explore` with the extension loaded answered "probe_ping NOT AVAILABLE".

## Why `mcp__codegraph__*` in `tools:` did nothing at first

Pi's default MCP exposure is `codemode`: server tools are callable from scripts but never declared to the model. The `codegraph` entry in `~/.pi/agent/mcp.json` had no `exposure`. With `"exposure": "direct"` a child with `tools: read, mcp__codegraph__*` received `mcp__codegraph__codegraph_explore` and called it. CodeGraph's own Pi installer (only on `main`, PR #3113, merged 2026-10-30, not in release 1.6.2) writes `exposure: "direct"` for the same reason.

## The CLI path

`codegraph status` and `codegraph explore` ran correctly through `bash` inside a subagent.

## What gentle-ai writes into the agent files

- Marker-fenced blocks: `<!-- gentle-ai:pi-codegraph-tool -->` (3 lines naming the dead `mcp` proxy tool), `<!-- gentle-ai:pi-codegraph-guidance -->` through `<!-- /gentle-ai:pi-codegraph -->` (about 30 lines of CodeGraph rules). They are written by `ReconcilePiCodeGraph` (`gentle-ai/internal/components/communitytool/pi_codegraph.go`) only when the community tool `codegraph` is selected; when it is not, the same function calls `UninstallPiCodeGraph`.
- In this machine `~/.gentle-ai/state.json` lists only `engram` in `components`, has `pending_sync: true`, and the blocks are still in all 10 agent files. What a real `gentle-ai sync` does with them has not been tested.
- The guidance block says "initialize immediately", which contradicts CodeGraph's own `CODEGRAPH_START` block ("skip CodeGraph entirely" when there is no `.codegraph/`): gentle-ai#5391.
- The explorer also keeps a package-owned line about the cwd-scoped `codegraph` tool (not inside the markers).

## Quirks

- `- "*": false` is the fifth line of the `tools` list in the gentle-pi package agent files (`assets/agents/jd-judge-a.md`, `jd-judge-b.md`, `review-*`). Still shipped in gentle-pi 4.7.0 and on gentle-shell `main` (checked 2026-11-08). gentle-pi filters it as a non-name entry (`extensions/gentle-agents.ts:360-367`, `TOOL_NAME = /^[A-Za-z0-9_.:-]+$/`); it has no deny-all meaning there, so removing it changes no tool list.
- The global `jd-judge-a/b` files carry it flattened as `tools: *": false, read, grep, find, bash, mcp`.

## Upstream state on 2026-11-08 (gentle-pi 4.7.0, gentle-ai 4.4.0 and `main`)

- The marker blocks are still written: `pi_codegraph.go` on gentle-ai `main` defines the three markers (lines 27-29) and appends them in `ReconcilePiCodeGraph`; its last change is 2026-11-06. The gentle-pi package files never contain them.
- gentle-pi 4.7.0 ships `mcp__codegraph__codegraph_explore` in the same six agents this extension adds it to (explore, verify, worker, jd-fix-agent, jd-judge-a, jd-judge-b), so the addition is a no-op there and still matters for older versions.
- Subagents run from `~/.pi/agent/agents`, `~/.pi/agent/subagents`, `<cwd>/.pi/agents` and `<cwd>/.pi/subagents`, later directory winning (`lib/agents-config.ts:207-221`); the package's `assets/agents` is not read at launch. At every `session_start` gentle-pi copies `assets/agents` into `~/.pi/agent/agents` (`lib/agent-assets.ts:605-633`, called from `extensions/gentle-ai.ts:12487`), but skips a file whose content does not match its hash in `~/.pi/agent/gentle-ai/managed-assets.json` unless its body is a known shipped body (`lib/agent-assets.ts:497-525`).
- On this machine `managed-assets.json` lists none of the ten agent files, and the files in `~/.pi/agent/agents` are older than 4.7.0 (the explorer lacks the web tools and has the earlier description). The `.pre-codegraph-subagents.bak` copies already carried the gentle-ai markers and model routing before this extension rewrote them. An isolated upgrade (install gentle-pi 4.6.0 into a scratch `GENTLE_PI_AGENT_HOME`, edit the ten agent files, then run the 4.7.0 `installPackageAssets(cwd, true, ["delegation", "review"])` that `session_start` runs) showed on 2026-11-08:
  - no edit: 10 of 10 upgraded to 4.7.0 and stay managed (control);
  - this extension's `normalizeAgent`: 8 of 10 kept their 4.6.0 content (only verify and jd-fix-agent upgraded);
  - a gentle-ai marker block appended: 10 of 10 kept 4.6.0 and left `managed-assets.json`;
  - one `model:` line added to the frontmatter: 10 of 10 not upgraded to 4.7.0.
  So any local edit, this extension's included, freezes an agent file at the version it had; once a file is out of `managed-assets.json`, later sessions skip it even when it is a pristine 4.7.0 file with one extra frontmatter line.

## Open questions for the implementation

- Should the normalizer also run on project-level `.pi/agents/`? The owner has only talked about the global directory.
- License and author fields for `package.json` (not decided; `private: true` until the owner publishes).
- Whether `gentle-shell install` differs from `pi install` for how often `session_start` runs.
- Whether to leave a backup before the first rewrite of an agent file or `mcp.json`.

## State of the machine when this was written

- Real agents in `~/.pi/agent/agents/` are unmodified.
- `~/.pi/agent/mcp.json` has `exposure: "direct"` on `codegraph` (backup: `mcp.json.bak-2026-11-03-pre-exposure`).
- Two throwaway probe agents still exist: `~/.pi/agent/agents/probe-mcp.md` and `probe-cli.md`.

## Prior art (npm and gentle-shell issues, searched 2026-11-03; not exhaustive)

No package found that normalizes gentle-shell agent definitions and the MCP exposure together.

- CodeGraph as a Pi tool: `@vndv/pi-codegraph`, `@henryqw/pi-codegraph`, `@estebanforge/pi-codegraph-enhanced`, `@bopstack/pi-codegraph`, `@izhimu/pi-codegraph`. They add a tool or auto-index; none edits agent files or `mcp.json`.
- Alternative subagent runtimes (`pi-subagent-manager`, `@ravshansbox/pi-subagent`, `@agwab/pi-subagent`, `@cr1ms0n/pi-subagent`...): own runtime, not a layer over gentle-shell's.
- MCP clients (`pi-mcp-extension`, `pi-mcp-adapter`...): not related to agent definitions.
- gentle-shell issues to know: #1686 (children lose MCP tools, the root of this), #2047 (child does not receive `codegraph`, closed not planned), #1540 (shell-centric CodeGraph block in bash-less agents caused retry loops, closed), #2738 (open, "Improve codegraph usage", content lives in a Discord thread that was not read).

## Dry run of the normalizer against the real agent files (2026-11-03, nothing written to ~/.pi/agent/agents)

All 10 files change, are idempotent on a second pass, and end with the expected `tools:` (MCP tool on explore, verify, worker, jd-fix-agent and both judges; review-* untouched apart from the removed blocks). The explorer's own body (package-owned, outside the markers) said to use the cwd-scoped `codegraph` tool and `operation: "init"`, a tool it no longer has after S2. The owner asked to rewrite those lines (S9, T7, done).

## Normalizer behavior decided on 2026-11-08 (T2) and implemented after it

Supersedes the normalizer described in the dry run above; the evidence is L6 and the design L7 in `odd/tasks/agent-file-freeze.md`.

- A file with no gentle-ai marker blocks is returned byte for byte (worker, explorer, a `"*": false` or `mcp` entry, a missing `mcp__codegraph__codegraph_explore`): the edit itself is what takes the file out of `managed-assets.json`.
- A file that still carries the blocks is already frozen: it loses the blocks, the dead `mcp` entry and `"*": false`, and gains the MCP tool when its name is one of the six. The explorer keeps its `codegraph` extension tool and its shipped instruction lines (S2, which reverses the T7 rewrite), so the normalizer no longer matches the 2026-11-03 dry run.
- No worker marker is appended to any file. A worker child is recognised from its own command line: gentle-pi passes an agent body over 1000 bytes as `<tmpdir>/gentle-pi-subagent-<agent>-<random>/instructions.md` after `--append-system-prompt`, so a directory named `gentle-pi-subagent-gentle-ai-worker-` in its argv identifies it, and a system prompt still carrying `<!-- codegraph-workflow:worker -->` (a file edited before this change) counts too. No environment variable carries the agent name (`src/prefetch.ts`).
- The `mcp.json` normalization is unchanged.

## The repair of frozen agent files (T5, for 0.7.0)

Evidence in L11-L13 of `odd/tasks/agent-file-freeze.md` and L14 for the verification below. The rule was approved by the owner (S8, S10, S11); the implementation lives in `src/repair.ts`, with the frozen normalizers in `src/legacy-agents.ts`.

- It runs in the extension factory, so it finishes before gentle-pi's startup install in the same session (L12: Pi awaits every factory before the startup `session_start`), and never when `GENTLE_PI_AGENTS_CHILD=1`. Only `<agentDir>/agents/*.md` is considered.
- gentle-pi is located the way Pi installs it: `<agentDir>/npm/node_modules/gentle-pi` with `package.json` name `gentle-pi` (Pi's managed path wins over legacy global installs, `dist/core/package-manager.js:1876-1900`). Its `assets/migrations/agent-body-history.json` (`schemaVersion: 1`, hashes of `agentBody`) decides whether a body is one gentle-pi ships: `agentBody` starts at `content.indexOf("\n---", 4)` and its hash is taken over the exact string, with no newline normalization (`lib/agent-assets.ts:243-252`).
- gentle-ai appends `body without its trailing newlines + "\n\n" + block`, so removing a block together with the whitespace around it leaves the shipped body minus its final newline; both forms are accepted. With that rule all ten of the owner's backups are shipped bodies (L12).
- A shipped body alone says nothing about the frontmatter above it, where the tools live (review finding R4-shipped-body-frontmatter, 2026-11-09). The shipped-body route therefore also requires the frontmatter, without `model:`/`thinking:`, to equal what the 0.1.0 or 0.2.0-0.6.0 normalizer writes from `<gentle-pi>/assets/agents/<name>.md`. On the owner's files `gentle-ai-verify` matches it from the installed 4.7.0 agent and `gentle-ai-worker`'s frontmatter matches too (only its body is the older 4.6.0 one), so all ten are still repaired; a hand-edited frontmatter is left alone.
- `model:`/`thinking:` come from `~/.pi/gentle-ai/models.json`, located with gentle-pi's own rule (`lib/gentle-shell-bundled.ts:238`: `GENTLE_PI_CONFIG_HOME`, then an absolute `GENTLE_SHELL_CONFIG_HOME`, then `~/.pi/gentle-ai`); a missing or unreadable file counts as no entries. The bundled-prefix branch of that rule is not reproduced, so under a bundled Gentle Shell every file with routing is skipped, not damaged.
- 0.1.0 and 0.2.0-0.6.0 share one normalizer (`git show v0.6.0:src/agents.ts`; 0.1.0 is `git show dbac2dd:src/agents.ts`), and they differ only in the worker marker append. `src/legacy-agents.ts` keeps both frozen copies; nothing on the writing path imports them.
- The frozen state is read from gentle-pi's own `~/.pi/agent/gentle-ai/managed-assets.json`: a file whose content hash is listed there is still rewritten on every install, so it was never frozen and is left alone silently. Without that check the repair would take every recreated file away again at each load.
- The swap is a rename to `<file>.codegraph-repair-pending` (S11), created only when the name is free (hard link then unlink, so a file another session just wrote is never replaced). The backup is never written or modified, and no second backup is created (S10). Settling is split in two: at load a pending copy is only removed when its file is back, because gentle-pi's own startup install has not run yet in that process and a missing file proves nothing; on the first `before_agent_start` of the parent session, after that install had its chance, a pending copy whose file is still missing is restored byte for byte and remembered in `~/.pi/agent/codegraph-subagents/repair-state.json` by content and backup hash, so that file is not tried again while it is unchanged.
- `GENTLE_PI_AGENT_HOME` wins over `PI_CODING_AGENT_DIR` and `~/.pi/agent` in gentle-pi's own agent home (`lib/agent-home.ts:10`). When it is set and resolves to another directory than the one this package repairs, gentle-pi recreates its agents there, so the repair is skipped entirely and says why; comparing the resolved paths case-insensitively on Windows is enough, since that is what decides which directory receives the files.

Verified on copies of the owner's real files (nothing written under `~/.pi`): all ten frozen agents and their backups qualify, the ten are renamed with their ten backups byte-identical, gentle-pi 4.7.0's own `assets/agents` files plus the routing from `models.json` recreate all ten with their `managed-assets.json` hashes, and the next load removes the ten pending copies and repairs nothing. UNPROVEN: the extension wiring has no test (the extension module needs the Pi runtime), no live Pi run of the repair, the two-sessions-at-once race, and `applySavedModelConfig` itself (only its documented output was reproduced).

## Network shares and the explorer prefetch (office trial 2026-11-04/05, ported 2026-11-05)

Observed on Windows with projects on SMB mapped drives; the trial notes and measurements are outside this repository. The specs of the port live in `odd/tasks/office-patch-port.md`.

- Subagent children run with the UNC working directory (`\server\share\...`), while the main session and the daemon it registers use the drive letter (`Y:\...`). `realpathSync.native` turns the drive into its UNC path, so roots are compared in that form (`src/paths.ts`).
- cmd.exe, which Windows needs for the npm `.cmd` shim, does not accept a UNC working directory: it runs the command in `C:\Windows` instead. Before the port, `codegraph sync -q` for a UNC project ran there, and the explorer's CLI prefetch failed with no trace. codegraph now runs from the temp folder with the project as an argument.
- cmd.exe expands `%VAR%` even inside double quotes: a folder `a%OS%b` reached codegraph as `aWindows_NTb`. The project path travels in an environment variable and the command line only references it. With delayed expansion enabled in the registry, `!VAR!` would still expand; it is off by default.
- CodeGraph keys daemons by the path spelling it is given: `W:\project` and `w:\project` ran two daemons for one project. Dead records stay in `~/.codegraph/daemons`, so the spelling of a live daemon is preferred.
- `codegraph explore` through the CLI opens the index in its own process every time (2.5-6 s on SMB) and starts no daemon; `codegraph serve --mcp` does start one. A warm daemon answered in 0.5-2 s, the slowest real prefetch in 8375 ms, hence the 10 s limit and no CLI fallback.
- The rule "if `.codegraph/` exists, use CodeGraph" was checked by models with Pi's `find`/`grep`, which respect `.gitignore`; `.codegraph/.gitignore` ignores everything in the folder, so they concluded there was no index. Hence the index notice.
- The CodeGraph file watcher fails on SMB (`File watcher error ... UNKNOWN: unknown error, watch` in `.codegraph/daemon.log`), so the session-start `codegraph sync` is what keeps the index current there.
- `node --test` exits 0 when its glob matches nothing, and the published package carries no `test/`; `npm test` now fails when no test ran.
