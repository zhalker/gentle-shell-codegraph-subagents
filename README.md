# @zhalker/gentle-shell-codegraph-subagents

Pi package that keeps CodeGraph reachable from gentle-shell subagents. On every session start it checks the global agent definitions and `mcp.json` and fixes what gentle-ai or the gentle-pi package left behind. Nothing is rewritten when everything is already right.

> **This package edits files in your Pi configuration.** On every session start it rewrites the agent definitions in `~/.pi/agent/agents/` and `~/.pi/agent/subagents/` and the `codegraph` entry in `~/.pi/agent/mcp.json`. It keeps a one-time backup of each file it changes as `<file>.pre-codegraph-subagents.bak`. Read "What it does" before installing, and see "Uninstall" to go back.

Upstream issue: Gentleman-Programming/gentle-shell#2804. License: MIT.

## What it does

In `~/.pi/agent/agents/` and `~/.pi/agent/subagents/` (or `$PI_CODING_AGENT_DIR`):

- Removes the blocks gentle-ai writes between `<!-- gentle-ai:pi-codegraph-tool -->` / `<!-- gentle-ai:pi-codegraph-guidance -->` and `<!-- /gentle-ai:pi-codegraph -->`.
- Removes the dead `mcp` entry (the retired `pi-mcp-adapter` proxy) and the `"*": false` entry from every `tools:` list.
- Adds `mcp__codegraph__codegraph_explore` to `gentle-ai-explore`, `gentle-ai-verify`, `gentle-ai-worker`, `jd-fix-agent`, `jd-judge-a` and `jd-judge-b`, removes the `codegraph` extension tool from `gentle-ai-explore`, and rewrites that agent's own CodeGraph instructions to use the MCP tool. Adds a routing marker to `gentle-ai-worker` for its first-prompt skill reminder.
- Leaves the `review-*` agents without CodeGraph.

The package also provides the `codegraph-workflow` skill. When Pi loads this packaged skill, the extension adds a reminder before the first user prompt of the parent session and the first prompt of `gentle-ai-worker` children. It does not add the reminder to other children. Pi handles skill name collisions; if Pi selects a different skill with that name, the extension does not direct the model to it as if it were the packaged skill. A local package is discovered in place rather than copied to the user's skills directory.

In `mcp.json`: selects `"direct"` for `codegraph_explore` under `toolExposure`, without changing the server-wide exposure. Explicit tool settings (including matching patterns), disabled servers, and hidden servers are preserved. At session start Pi warns when the CodeGraph MCP server is not configured, without creating it, or when direct subagent access may be unavailable; it also warns if a hidden server has an explicit direct explore exception, which Pi can still expose. Trusted project MCP configuration and servers registered by extensions are considered. A configuration change may require a reload before Pi uses it.

In a subagent that only reads and holds `mcp__codegraph__codegraph_explore` (the explorer), a `before_agent_start` hook also runs `codegraph_explore` for its task once before the first model call and hands the output to the model as a message, bounded to 10 s and 12,000 characters. It asks the project's running CodeGraph daemon directly (the same text as the CLI, locally ~75 ms against ~590 ms). When there is no daemon it adds nothing at once and starts the project's warm-up in the background, so the next explorer finds the daemon warm; it never runs `codegraph explore` and never waits for a daemon it would have to start. If the project has no `.codegraph/` index, the package's init lock is held, or the daemon has nothing to say, nothing is added and the run continues as before.

On the first prompt of a session, and of a child that holds a CodeGraph tool, the extension also states that the project's index exists and names the CodeGraph tools to call first, because a model on its own checks with find or grep, which never show the git-ignored `.codegraph/`. The main session sees this notice; children get it hidden. Every explorer pre-fetch appends `time, outcome, duration, directory` to `~/.pi/agent/codegraph-subagents/prefetch.log` (outcomes: `ok`, `empty`, `daemon-timeout`, `skipped-no-daemon`, `skipped-init-running`), so a pre-fetch that silently produced nothing can still be diagnosed.

In the directory where Pi starts, a new session also looks after the CodeGraph index, in the background (the session never waits for it):

- If `.codegraph/` exists, it runs `codegraph sync`. The CodeGraph file watcher does not work on SMB mounts, so without this the index stays as it was.
- If there is no `.codegraph/`, but there is a `.git` and one of `composer.json`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle` or `build.gradle.kts`, it runs `codegraph init -y`. In any other directory nothing is created.
- When there is an index (existing, or just created), it then warms the project's CodeGraph daemon: a short MCP client runs one small `codegraph_explore` and disconnects, and the daemon stays up for as long as your session keeps it. The first real call of the orchestrator and of every subagent is then fast (locally 620-650 ms cold against ~70 ms warm). The explorer's pre-fetch asks that same daemon, so it gets the same speed-up.
- `codegraph` always runs from the temp folder with the project as an argument (`sync -q <project>`, `init -y <project>`, `serve --mcp -p <project>`), never with the project as its working directory: on Windows, cmd.exe does not accept a UNC working directory and would run the command in the Windows directory. The path reaches `codegraph` literally, whatever characters the folder name has (`%`, `&`, `^`, spaces). It is spelled as the project's live daemon registered it, because CodeGraph starts one daemon per spelling. A mapped drive (`Y:\...`) and the UNC path behind it (`\\server\share\...`), and two letter cases of one path, are the same project.
- Pi shows a notice when each step starts ("syncing the CodeGraph index...", "creating the CodeGraph index of this project...", "warming up CodeGraph...") and another when it ends ("CodeGraph index synced", "CodeGraph index created", "CodeGraph ready"), or a warning if it failed.
- Concurrent rewrites of agent files and `mcp.json` are tolerated (an existing backup is kept, and transient collisions are retried). A per-project lock in the user's temp folder coordinates package-started initializations: a session that finds it held skips init, sync and warm-up, and the explorer skips its prefetch. When a session exits during init, the package also checks CodeGraph's writer lock. On Windows it conservatively holds the package lock for 60 seconds after spawning the shell, covering the period before CodeGraph writes its own lock. Locks are treated as stale after 11 minutes.
- Subagent children and `/reload` do nothing; startup, new, resume and fork do.

Before the first change to a file it saves the original next to it as `<file>.pre-codegraph-subagents.bak`; later changes never overwrite that backup.

## Install

```
pi install npm:@zhalker/gentle-shell-codegraph-subagents
```

Changes apply on the next session start. Reinstalling, or running `gentle-ai sync` again, is corrected the same way on the following start.

## Uninstall

Remove the package, then copy each `*.pre-codegraph-subagents.bak` over its original if you want the previous files back.

## Known limits

- Only the global agent directory is handled, not `<project>/.pi/agents/`.
- The warm-up has only been measured on local disks, not on a network share. It never kills the processes it starts, because the daemon is shared with your own sessions.
- CodeGraph's own `init` can hang when two start at once, or when a daemon opens the project just after the index is created. The package lock only coordinates sessions sharing the same user temp folder; it cannot prevent access by a terminal, another tool, another user, or Pi's own MCP connection. On Windows, if the session and shell exit before CodeGraph writes its own lock and that takes more than 60 seconds, the package cannot tell that init is still running. The 11-minute stale-lock limit can also expire while a process remains alive.
- The index sync is a background command: a prefetch that runs before it finishes can see the previous index. The sync only looks at the directory where Pi starts, not at parents or subfolders. Treat prefetched results as navigation hints, not authoritative evidence: they can be stale, incomplete, truncated or incorrect; verify findings against source files.
- Asking the daemon directly relies on two internal details of CodeGraph: the registry in `~/.codegraph/daemons/` and the hello line with `protocol: 1`. If either changes, or the daemon answers anything unexpected, the explorer adds nothing and the warm-up starts in the background instead. A daemon that is there but does not answer within 10 s is not retried.
- A background warm-up dies with the explorer child that started it, so a child that ends within about 3 s warms nothing; a real explorer session lasts much longer. The 10 s prefetch limit was chosen from measured answers up to 8375 ms on a network share, and the daemon warm-up of a session start is awaited and keeps its own 120 s limit.
- The explorer prefetch requires the launcher to set `GENTLE_PI_AGENTS_CHILD=1` and `GENTLE_PI_AGENTS_REQUESTED_TOOLS` to the child's declared comma-separated tool list. It recognizes a read-only child with the CodeGraph MCP tool and no writing tools; this declaration does not prove the MCP tool actually connected. Without these launcher variables the prefetch is skipped. The first 300 sanitized characters of the task become the query, so verbose instructions can broaden the result; the returned context is capped at 12,000 characters.
- The rewrite of the explorer's own instructions matches known sentences; if gentle-pi rewords them, they are left as they are.
- The `codegraph` MCP server has to be configured or registered by an extension; the package never creates it. When Pi is launched from a GUI or service, its `PATH` may differ from your shell. An absolute MCP server command can fix the server launch, but this package's `init` and `sync` still need `codegraph` on Pi's `PATH`.
- Tested with Pi 1.4.0 and node 24.

## Development

`npm test` runs the unit tests with Node's built-in runner, through `scripts/run-tests.mjs`: unlike `node --test`, it fails when no test ran, so an empty or mistyped glob cannot pass `prepublishOnly`. Other globs can be passed as arguments (`node scripts/run-tests.mjs test/paths.test.ts`).
