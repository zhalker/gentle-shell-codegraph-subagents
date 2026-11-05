import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const hasCodegraph = spawnSync("codegraph", ["--version"], { shell: true, stdio: "ignore" }).status === 0;

/** A project with an index, big enough that a cold daemon is visibly slower than a warm one. */
export function indexedProject(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pcs-real-")));
	mkdirSync(join(dir, "src"));
	for (let i = 0; i < 60; i++) {
		writeFileSync(join(dir, "src", `mod${i}.ts`), `export function warmFn${i}(x: number) { return x + ${i}; }\nexport class WarmCls${i} { run() { return warmFn${i}(${i}); } }\n`);
	}
	const init = spawnSync("codegraph", ["init", "-y"], { cwd: dir, shell: true, stdio: "ignore" });
	assert.equal(init.status, 0, "codegraph init failed");
	return dir;
}

/** Daemons whose root is exactly `dir`; the user's own daemons are never touched. */
export function daemonPids(dir: string): number[] {
	const listing = spawnSync("codegraph", ["daemon"], { shell: true, encoding: "utf8" }).stdout ?? "";
	return listing
		.split(/\r?\n/)
		.filter((line) => line.toLowerCase().includes(dir.toLowerCase()))
		.map((line) => Number(/^pid (\d+)/.exec(line)?.[1]))
		.filter((pid) => Number.isInteger(pid));
}

export function stopDaemon(dir: string): void {
	for (const pid of daemonPids(dir)) spawnSync("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore" });
}
