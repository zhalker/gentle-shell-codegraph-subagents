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

- `- "*": false` is the fifth line of the `tools` list in the gentle-pi package agent files (`assets/agents/jd-judge-a.md`, `jd-judge-b.md`, `review-*`). Pi reads it as a tool called `*": false`. Probably only a warning; not verified.
- The global `jd-judge-a/b` files carry it flattened as `tools: *": false, read, grep, find, bash, mcp`.

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
