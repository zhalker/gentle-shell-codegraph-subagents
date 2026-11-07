// Entry point for the lock tests: one "session" trying to take the init lock at a given instant.
// A hold of "stdin" keeps an acquired lock until the test closes this worker's stdin, so a session that reaches
// the start line late still finds the lock taken instead of taking it after the winner let it go.
// With mode "orphan" it hands the lock to a long-running child of its own and exits at once without releasing,
// like a Pi that dies while its init goes on.
// With mode "shell" it starts the init the way the package does on Windows (through a shell) and adopts the
// pid of that shell, which can die while the init itself goes on.
// With mode "sync" it is one session asking for a coordinated index sync: its fake sync records start and
// end in `<project>/runs.log` and lasts `holdMs`, so the test can see whether two ever overlapped.
// With mode "sync-cli" its run starts a detached CLI that keeps writing for `holdMs` after the session is killed,
// and reports that pid as the process the sync started, like `codegraph sync` outliving a killed Pi.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compactionSyncLock } from "../src/compaction-sync.ts";
import { tryAcquireInitLock } from "../src/initlock.ts";

const [, , lockDir, project, startAt, holdMs, mode] = process.argv;
while (Date.now() < Number(startAt)) { /* spin until every session starts at the same instant */ }
if (mode === "sync" || mode === "sync-cli") {
	const ledger = join(project, "runs.log");
	const requestedAt = Date.now();
	const outcome = await compactionSyncLock({ dir: lockDir, pollMs: 10, requestWaitMs: 60_000 }).request(project, async (onSpawn) => {
		if (mode === "sync") {
			appendFileSync(ledger, `start ${Date.now()} ${process.pid}\n`);
			await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
			appendFileSync(ledger, `end ${Date.now()} ${process.pid}\n`);
			return { ran: true, ok: true };
		}
		// The command this session runs outlives it: a detached process writing the index for `holdMs`.
		const script = `const fs = require("node:fs"); const ledger = ${JSON.stringify(ledger)}; `
			+ `fs.appendFileSync(ledger, "cli-start " + Date.now() + "\\n"); `
			+ `setTimeout(() => { fs.appendFileSync(ledger, "cli-end " + Date.now() + "\\n"); }, ${Number(holdMs)});`;
		const cli = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", windowsHide: true });
		cli.unref();
		onSpawn(cli.pid!);
		console.log(JSON.stringify({ status: "running", pid: process.pid, cliPid: cli.pid, requestedAt }));
		// The session stays inside its run until the test kills it.
		await new Promise(() => {});
		return { ran: true, ok: true };
	});
	console.log(JSON.stringify({ status: "synced", pid: process.pid, requestedAt, returnedAt: Date.now(), outcome }));
	process.exit(0);
}
const attempt = tryAcquireInitLock(project, { dir: lockDir });
if (mode === "orphan" && attempt.status === "acquired") {
	const init = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${Number(holdMs)})`], { detached: true, stdio: "ignore" });
	init.unref();
	attempt.adopt(init.pid!);
	console.log(JSON.stringify({ status: attempt.status, pid: process.pid, initPid: init.pid }));
	process.exit(0);
}
if (mode === "shell" && attempt.status === "acquired") {
	const command = [process.execPath, join(import.meta.dirname, "orphan-init-process.ts"), project, String(Number(holdMs))]
		.map((part) => `"${part}"`)
		.join(" ");
	const shell = spawn(command, { shell: true, stdio: "ignore", windowsHide: true });
	attempt.adopt(shell.pid!, { proxy: true });
	// Let the init announce itself before this session exits, so the shell's death cannot take it down.
	const announced = join(project, ".codegraph", "codegraph.lock");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try { readFileSync(announced, "utf8"); break; } catch { /* not yet */ }
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	console.log(JSON.stringify({ status: attempt.status, pid: process.pid, initPid: shell.pid }));
	process.exit(0);
}
console.log(JSON.stringify({ status: attempt.status, pid: process.pid }));
if (attempt.status === "acquired") {
	if (holdMs === "stdin") {
		await new Promise((resolve) => { process.stdin.on("end", resolve); process.stdin.on("close", resolve); process.stdin.resume(); });
	} else {
		await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
	}
	attempt.release();
}
