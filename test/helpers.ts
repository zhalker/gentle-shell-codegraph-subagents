import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WARMUP_TIMEOUT_MS } from "../src/warmup.ts";

export const hasCodegraph = spawnSync("codegraph", ["--version"], { shell: true, stdio: "ignore" }).status === 0;

/** Directories this test process created, with the time just before each was created. */
const owned = new Map<string, number>();
const ownedKey = (dir: string) => (process.platform === "win32" ? resolve(dir).toLowerCase() : resolve(dir));

/** A new temp directory recorded as created by this test process. */
export function ownedDir(prefix: string): string {
	const createdAt = Date.now();
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	owned.set(ownedKey(dir), createdAt);
	return dir;
}

/** A project with an index, big enough that a cold daemon is visibly slower than a warm one. */
export function indexedProject(): string {
	// Inherited by the `codegraph serve` this process spawns and by the daemon it starts; see stopDaemon.
	process.env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS = String(DAEMON_IDLE_TIMEOUT_MS);
	const dir = ownedDir("pcs-real-");
	mkdirSync(join(dir, "src"));
	for (let i = 0; i < 60; i++) {
		writeFileSync(join(dir, "src", `mod${i}.ts`), `export function warmFn${i}(x: number) { return x + ${i}; }\nexport class WarmCls${i} { run() { return warmFn${i}(${i}); } }\n`);
	}
	const init = spawnSync("codegraph", ["init", "-y"], { cwd: dir, shell: true, stdio: "ignore" });
	assert.equal(init.status, 0, "codegraph init failed");
	return dir;
}

/**
 * These helpers never kill a process. CodeGraph starts the project daemon as a detached grandchild of the
 * `codegraph serve` the code under test spawns, so this test never holds a pid recorded at the daemon's launch,
 * and every other source of a pid (the daemon lock, the registry, a listing, the socket greeting) can name an
 * unrelated process. Instead, a daemon started for a project made by indexedProject leaves on its own: its idle
 * timeout is shortened for the daemons this test process starts, and stopDaemon only waits for that.
 */
export const DAEMON_IDLE_TIMEOUT_MS = 8_000;
/**
 * How long stopDaemon waits for a daemon to leave on its own before it reports it, still running: a warm-up
 * client may hold it for up to WARMUP_TIMEOUT_MS, then its idle timeout runs, plus room for a loaded machine.
 */
export const DAEMON_LEAVE_WAIT_MS = WARMUP_TIMEOUT_MS + DAEMON_IDLE_TIMEOUT_MS + 22_000;

const processAlive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

// Built with String.fromCharCode, like BACKSLASH below: no shell, heredoc or copy step can eat these backslashes.
const B = String.fromCharCode(92);
const PIPE_PREFIX = `${B}${B}.${B}pipe${B}`;
/** Spellings of the pipe folder to list, in order; the forward-slash one is the same folder to Windows. */
const PIPE_FOLDERS = [PIPE_PREFIX, "//./pipe/"];

/**
 * The lower-cased names of the Windows named pipes, or why this process cannot list them. Listing never
 * connects to a pipe: opening one, even to stat it, would be a client that restarts a daemon's idle timeout.
 */
export function listPipes(): { names: Set<string> } | { errors: string[] } {
	const errors: string[] = [];
	for (const folder of PIPE_FOLDERS) {
		try {
			return { names: new Set(readdirSync(folder).map((entry) => entry.toLowerCase())) };
		} catch (error) {
			errors.push(`${JSON.stringify(folder)}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
		}
	}
	return { errors };
}

/** Whether something still serves this socket: true, false, or the reason this process cannot tell. */
function socketPresent(socketPath: string): boolean | { unknown: string } {
	if (process.platform !== "win32" || !socketPath.toLowerCase().startsWith(PIPE_PREFIX)) return existsSync(socketPath);
	const pipes = listPipes();
	if ("errors" in pipes) return { unknown: `named pipes cannot be listed here (${pipes.errors.join("; ")})` };
	return pipes.names.has(socketPath.slice(PIPE_PREFIX.length).toLowerCase());
}

/**
 * An observation, never a kill target: the pid in the daemon lock of `dir`, while that pid runs and the lock's
 * socket is still served, for a lock written after this test process created `dir`. A forged or stale lock can
 * make this report a process that is not the daemon; nothing here acts on that pid. When the socket cannot be
 * checked, the daemon counts as still there, with the reason: unknown is never reported as gone.
 */
function observedDaemon(dir: string): { pid: number; unknown?: string } | undefined {
	const createdAt = owned.get(ownedKey(dir));
	if (createdAt === undefined) {
		throw new Error(`${dir} was not created by this test process (use ownedDir or indexedProject): refusing to touch its processes`);
	}
	let lock: { pid?: unknown; socketPath?: unknown; startedAt?: unknown };
	try { lock = JSON.parse(readFileSync(join(dir, ".codegraph", "daemon.pid"), "utf8")); } catch { return undefined; }
	const { pid, socketPath, startedAt } = lock;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (typeof socketPath !== "string" || socketPath.length === 0) return undefined;
	if (typeof startedAt !== "number" || startedAt < createdAt) return undefined;
	if (!processAlive(pid)) return undefined;
	const present = socketPresent(socketPath);
	if (present === false) return undefined;
	return present === true ? { pid } : { pid, unknown: present.unknown };
}

/** The daemon seen serving `dir`, as zero or one pid; for counting only, see observedDaemon. */
export function daemonPids(dir: string): number[] {
	const seen = observedDaemon(dir);
	return seen === undefined ? [] : [seen.pid];
}

/**
 * Waits until no daemon serves `dir`: the daemons this test process starts leave on their own after
 * DAEMON_IDLE_TIMEOUT_MS without clients. Kills nothing; one still there after `waitMs` is reported, running.
 * The wait is asynchronous on purpose: the daemon's clients include background warm-ups of this very process,
 * which need its event loop to send their explore call and leave, and a blocking wait would keep them, and so
 * the daemon, there until it gave up. Resolves at once, with nothing scheduled, when no daemon serves `dir`.
 */
export async function stopDaemon(dir: string, options: { waitMs?: number } = {}): Promise<void> {
	const deadline = Date.now() + (options.waitMs ?? DAEMON_LEAVE_WAIT_MS);
	let seen: ReturnType<typeof observedDaemon>;
	while ((seen = observedDaemon(dir)) !== undefined) {
		if (Date.now() > deadline) {
			const why = seen.unknown === undefined ? "" : ` (whether its socket is gone is unknown: ${seen.unknown})`;
			throw new Error(`a daemon (pid ${seen.pid} by its lock) still serves ${dir}${why}; nothing proves this test started that pid, so it was left running`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
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
