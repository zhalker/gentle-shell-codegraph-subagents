// Entry point for the lock tests: one "session" trying to take the init lock at a given instant.
// With mode "orphan" it hands the lock to a long-running child of its own and exits at once without releasing,
// like a Pi that dies while its init goes on.
// With mode "shell" it starts the init the way the package does on Windows (through a shell) and adopts the
// pid of that shell, which can die while the init itself goes on.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tryAcquireInitLock } from "../src/initlock.ts";

const [, , lockDir, project, startAt, holdMs, mode] = process.argv;
while (Date.now() < Number(startAt)) { /* spin until every session starts at the same instant */ }
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
	await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
	attempt.release();
}
