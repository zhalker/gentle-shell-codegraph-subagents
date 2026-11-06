# @zhalker/gentle-shell-codegraph-subagents

Pi package that keeps CodeGraph reachable, and actually used, by gentle-shell subagents. Install it once: on every session start it fixes the agents' tool lists and the CodeGraph MCP exposure, keeps the project index synced and its daemon warm, and hands the explorer subagent CodeGraph's answer before it even starts.

Upstream issue: Gentleman-Programming/gentle-shell#2804. License: MIT.

## Features

- **CodeGraph in every subagent that should have it.** On each session start the explorer, verifier, worker and judge agents get `mcp__codegraph__codegraph_explore` in their tool list, and stale gentle-ai blocks and dead proxy entries are removed. Review agents are left untouched.
- **The MCP tool is really there.** `codegraph_explore` is exposed directly to subagents in `mcp.json`, keeping every other setting you made. If the CodeGraph server is missing, Pi tells you at startup.
- **The model knows the index exists.** On the first prompt of a session, and of every subagent that holds a CodeGraph tool, the extension states that the project has an index and names the exact tools to call first. Models no longer "check" with find or grep, which never show the git-ignored `.codegraph/`. It comes back after each compaction, which would otherwise summarize it away, and on screen it is one short line that expands to the full text.
- **The explorer starts with an answer.** Before its first model call, the explorer subagent receives CodeGraph's answer for its task straight from the running daemon: about 75 ms on a local disk, typically 1-2 s on a network share.
- **Always-fresh index.** Every new session syncs the index in the background, or creates it for a git project with a known manifest (`package.json`, `composer.json`, `go.mod`, `Cargo.toml` and more). Your session never waits for it.
- **Warm from the first call.** After syncing, the extension warms the project's CodeGraph daemon, so the first real query is fast (~70 ms instead of ~650 ms locally). When an explorer finds no daemon, it starts one in the background for the next one.
- **Built for Windows and network shares.** A mapped drive (`Y:\`) and its UNC path (`\\server\share`) are the same project, so no duplicate daemons. CodeGraph runs correctly on UNC folders, and any folder name reaches it intact (`%`, `&`, `^`, spaces).
- **Protected from conflicting rules.** Some `AGENTS.md` files tell the model to run `codegraph index` or `codegraph sync` before every search. The extension blocks `codegraph index` where an index already exists, because rebuilding it stops the daemon, and tells you once per project which file holds such a rule, why it conflicts and what keeping it costs.
- **A CodeGraph workflow skill included.** The packaged `codegraph-workflow` skill tells the model when to use CodeGraph and when a plain read or grep is better, with a reminder on the first prompt of the session and of worker subagents.
- **Safe to install, easy to undo.** It edits only the agent definitions in `~/.pi/agent/agents/` and `~/.pi/agent/subagents/` and the `codegraph` entry of `~/.pi/agent/mcp.json`. Each file is backed up once as `<file>.pre-codegraph-subagents.bak` before its first change, nothing is rewritten when everything is already right, and concurrent sessions coordinate through a per-project lock.
- **Diagnosable.** Every explorer prefetch writes its outcome and duration to `~/.pi/agent/codegraph-subagents/prefetch.log`.

## Why

Gentle-shell subagents often skip CodeGraph and fall back to recursive grep: their tool lists lack it, the MCP server hides it from them, or the model decides there is no index because `.codegraph/` is git-ignored and invisible to `find` and `grep`. On network shares the CodeGraph file watcher does not work either, so the index goes stale. This package fixes each of those at session start.

## Requirements

- Pi with gentle-pi (gentle-shell subagents). Tested with Pi 1.4.0-1.5.0.
- The CodeGraph CLI on Pi's `PATH`, and the `codegraph` MCP server configured.
- Node 24.

## Install

```
pi install npm:@zhalker/gentle-shell-codegraph-subagents
```

Changes apply on the next session start. Reinstalling, or running `gentle-ai sync` again, is corrected the same way on the following start.

## Uninstall

Remove the package, then copy each `*.pre-codegraph-subagents.bak` over its original if you want the previous files back.

## How it works

In `~/.pi/agent/agents/` and `~/.pi/agent/subagents/` (or `$PI_CODING_AGENT_DIR`):

- Removes the blocks gentle-ai writes between `<!-- gentle-ai:pi-codegraph-tool -->` / `<!-- gentle-ai:pi-codegraph-guidance -->` and `<!-- /gentle-ai:pi-codegraph -->`.
- Removes the dead `mcp` entry (the retired `pi-mcp-adapter` proxy) and the `"*": false` entry from every `tools:` list.
- Adds `mcp__codegraph__codegraph_explore` to `gentle-ai-explore`, `gentle-ai-verify`, `gentle-ai-worker`, `jd-fix-agent`, `jd-judge-a` and `jd-judge-b`, removes the `codegraph` extension tool from `gentle-ai-explore`, and rewrites that agent's own CodeGraph instructions to use the MCP tool. Adds a routing marker to `gentle-ai-worker` for its first-prompt skill reminder.
- Leaves the `review-*` agents without CodeGraph.

The package also provides the `codegraph-workflow` skill. When Pi loads this packaged skill, the extension adds a reminder before the first user prompt of the parent session and the first prompt of `gentle-ai-worker` children. It does not add the reminder to other children. Pi handles skill name collisions; if Pi selects a different skill with that name, the extension does not direct the model to it as if it were the packaged skill. A local package is discovered in place rather than copied to the user's skills directory.

In `mcp.json`: selects `"direct"` for `codegraph_explore` under `toolExposure`, without changing the server-wide exposure. Explicit tool settings (including matching patterns), disabled servers, and hidden servers are preserved. At session start Pi warns when the CodeGraph MCP server is not configured, without creating it, or when direct subagent access may be unavailable; it also warns if a hidden server has an explicit direct explore exception, which Pi can still expose. Trusted project MCP configuration and servers registered by extensions are considered. A configuration change may require a reload before Pi uses it.

In a subagent that only reads and holds `mcp__codegraph__codegraph_explore` (the explorer), a `before_agent_start` hook also runs `codegraph_explore` for its task once before the first model call and hands the output to the model as a message, bounded to 10 s and 12,000 characters. It asks the project's running CodeGraph daemon directly (the same text as the CLI, locally ~75 ms against ~590 ms). When there is no daemon it adds nothing at once and starts the project's warm-up in the background, so the next explorer finds the daemon warm; it never runs `codegraph explore` and never waits for a daemon it would have to start. If the project has no `.codegraph/` index, the package's init lock is held, or the daemon has nothing to say, nothing is added and the run continues as before.

On the first prompt of a session, and of a child that holds a CodeGraph tool, the extension also states that the project's index exists and names the CodeGraph tools to call first, because a model on its own checks with find or grep, which never show the git-ignored `.codegraph/`. The main session sees this notice as one short line (`ctrl+o` expands it to the full text the model received); children get it hidden. After a compaction the summary usually drops the notice and the skill reminder, so the first user prompt after it carries them again, once and always hidden; while they are still in what the model sees they are not repeated. Every explorer pre-fetch appends `time, outcome, duration, directory` to `~/.pi/agent/codegraph-subagents/prefetch.log` (outcomes: `ok`, `empty`, `daemon-timeout`, `daemon-error`, `skipped-no-daemon`, `skipped-init-running`; control characters in the directory are written as `?`), so a pre-fetch that silently produced nothing can still be diagnosed.

When the model runs `codegraph index` through `bash` or `bash_background`, in a project that already has an index (`.codegraph/codegraph.db` in that folder or a parent; a path given right after `index` is the project), a `tool_call` hook blocks the call and tells the model why: the index is already synced, and a rebuild stops the running daemon. `codegraph init` and `codegraph sync` are never blocked. A command that sets `CODEGRAPH_SUBAGENTS_ALLOW=1` (for example `CODEGRAPH_SUBAGENTS_ALLOW=1 codegraph index`) is never blocked either, for a deliberate full rebuild; the block reason names it.

On the first prompt of the main session, the extension also reads the context files Pi loaded (the global `AGENTS.md` or `CLAUDE.md`, and those of the project and its parents). When one asks to run `codegraph index`, or `codegraph init` or `sync` always or before every use, Pi shows one warning that names the file, why it conflicts and what keeping the rule costs. It is shown once per project, even after the file changes: the projects already warned are recorded in `~/.pi/agent/codegraph-subagents/conflict-notices.json`, and no file names or contents are stored.

In the directory where Pi starts, a new session also looks after the CodeGraph index, in the background (the session never waits for it):

- If `.codegraph/` exists, it runs `codegraph sync`. The CodeGraph file watcher does not work on SMB mounts, so without this the index stays as it was.
- If there is no `.codegraph/`, but there is a `.git` and one of `composer.json`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle` or `build.gradle.kts`, it runs `codegraph init -y`. In any other directory nothing is created.
- When there is an index (existing, or just created), it then warms the project's CodeGraph daemon: a short MCP client runs one small `codegraph_explore` and disconnects, and the daemon stays up for as long as your session keeps it. The first real call of the orchestrator and of every subagent is then fast (locally 620-650 ms cold against ~70 ms warm). The explorer's pre-fetch asks that same daemon, so it gets the same speed-up.
- `codegraph` always runs from the temp folder with the project as an argument (`sync -q <project>`, `init -y <project>`, `serve --mcp -p <project>`), never with the project as its working directory: on Windows, cmd.exe does not accept a UNC working directory and would run the command in the Windows directory. The path reaches `codegraph` literally, whatever characters the folder name has (`%`, `&`, `^`, spaces). It is spelled as the project's live daemon registered it (a record counts as live only while its process runs and its socket is still present), because CodeGraph starts one daemon per spelling. A mapped drive (`Y:\...`) and the UNC path behind it (`\\server\share\...`), and two letter cases of one path, are the same project.
- Pi shows a notice when each step starts ("syncing the CodeGraph index...", "creating the CodeGraph index of this project...", "warming up CodeGraph...") and another when it ends ("CodeGraph index synced", "CodeGraph index created", "CodeGraph ready"), or a warning if it failed.
- Concurrent rewrites of agent files and `mcp.json` are tolerated (an existing backup is kept, and transient collisions are retried). A per-project lock in the user's temp folder coordinates package-started initializations: a session that finds it held skips init, sync and warm-up, and the explorer skips its prefetch. When a session exits during init, the package also checks CodeGraph's writer lock. On Windows it conservatively holds the package lock for 60 seconds after spawning the shell, covering the period before CodeGraph writes its own lock. Locks are treated as stale after 11 minutes.
- Subagent children and `/reload` do nothing; startup, new, resume and fork do.

Before the first change to a file it saves the original next to it as `<file>.pre-codegraph-subagents.bak`; later changes never overwrite that backup.

## Contributing

Issues and pull requests are welcome. `npm test` runs the unit tests with Node's built-in runner, through `scripts/run-tests.mjs`: unlike `node --test`, it fails when no test ran, so an empty or mistyped glob cannot pass `prepublishOnly`. Other globs can be passed as arguments (`node scripts/run-tests.mjs test/paths.test.ts`).

Details on edge cases and design trade-offs: [docs/known-limits.md](docs/known-limits.md).
