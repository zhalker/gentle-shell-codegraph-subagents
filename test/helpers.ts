import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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

/** Built with String.fromCharCode so no shell or heredoc can eat the backslashes of a UNC path. */
export const BACKSLASH = String.fromCharCode(92);

/** A drive letter mapped to a network share and the UNC path behind it, if this machine has one; never written to. */
export function mappedDrive(): { drive: string; unc: string } | undefined {
	if (process.platform !== "win32") return undefined;
	for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
		const drive = `${letter}:${BACKSLASH}`;
		try {
			const unc = realpathSync.native(drive);
			if (unc.startsWith(BACKSLASH + BACKSLASH)) return { drive, unc };
		} catch { /* not mapped or not reachable */ }
	}
	return undefined;
}

/** The same local directory through the administrative share (\\localhost\c$\...), if reachable. */
export function adminShareOf(dir: string): string | undefined {
	if (process.platform !== "win32" || !/^[A-Za-z]:\\/.test(dir)) return undefined;
	const unc = `${BACKSLASH}${BACKSLASH}localhost${BACKSLASH}${dir[0].toLowerCase()}$${dir.slice(2)}`;
	return existsSync(unc) ? unc : undefined;
}

/**
 * A fake `codegraph` on a new PATH entry that records its working directory and arguments to `out` and
 * exits 0. Windows gets a .cmd shim, as npm installs it; elsewhere an executable script.
 */
export function fakeCodegraph(out: string): { dir: string; restore(): void } {
	const dir = mkdtempSync(join(tmpdir(), "pcs-fakecg-"));
	const recorder = join(dir, "record.js");
	writeFileSync(recorder, `require("node:fs").writeFileSync(${JSON.stringify(out)}, process.cwd() + "|" + process.argv.slice(2).join(" "));\n`);
	if (process.platform === "win32") {
		writeFileSync(join(dir, "codegraph.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0record.js" %*\r\n`);
	} else {
		writeFileSync(join(dir, "codegraph"), `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`);
		chmodSync(join(dir, "codegraph"), 0o755);
	}
	const oldPath = process.env.PATH ?? "";
	process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${oldPath}`;
	return { dir, restore: () => { process.env.PATH = oldPath; } };
}
