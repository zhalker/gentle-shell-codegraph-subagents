// The real-daemon tests end with the daemon they started gone. That cleanup never kills a process: no pid it can
// read (a daemon listing, a stale or forged lock, a forged greeting) proves this test launched it. It only waits
// for the daemon to leave on its own, and reports one that stays.
// Every process here is a child of this test (a decoy or a fake daemon), and a fake `codegraph` comes first on
// PATH, so no real daemon and no real `codegraph daemon` picker is ever reached.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import { join } from "node:path";
import { daemonPids, listPipes, ownedDir, stopDaemon } from "./helpers.ts";

const FAKE_MARKER = "PCS-FAKE-CODEGRAPH";
const fakeBin = mkdtempSync(join(tmpdir(), "pcs-cleanup-bin-"));
const listingFile = join(fakeBin, "listing.txt");
const oldPath = process.env.PATH ?? "";

/** What the fake `codegraph daemon` prints: one line per daemon, in the shape the old helper parsed. */
const setListing = (lines: string[]) => writeFileSync(listingFile, lines.join("\n") + (lines.length > 0 ? "\n" : ""));

// At module level, not in a hook: if the fake is not first on PATH, the file aborts before any test body runs.
{
	writeFileSync(join(fakeBin, "fake.js"), [
		`const fs = require("node:fs");`,
		`if (process.argv[2] === "--pcs-probe") { process.stdout.write(${JSON.stringify(FAKE_MARKER)}); process.exit(0); }`,
		`try { process.stdout.write(fs.readFileSync(${JSON.stringify(listingFile)}, "utf8")); } catch {}`,
	].join("\n"));
	if (process.platform === "win32") {
		writeFileSync(join(fakeBin, "codegraph.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake.js" %*\r\n`);
	} else {
		writeFileSync(join(fakeBin, "codegraph"), `#!/bin/sh\nexec "${process.execPath}" "${join(fakeBin, "fake.js")}" "$@"\n`);
		chmodSync(join(fakeBin, "codegraph"), 0o755);
	}
	setListing([]);
	process.env.PATH = `${fakeBin}${process.platform === "win32" ? ";" : ":"}${oldPath}`;
	const probe = spawnSync("codegraph", ["--pcs-probe"], { shell: true, encoding: "utf8" });
	// Without the fake first on PATH nothing below may run: a real listing names the user's own daemons.
	if (!String(probe.stdout).includes(FAKE_MARKER)) throw new Error(`the fake codegraph is not first on PATH: ${probe.stdout} ${probe.stderr}`);
}

after(() => {
	process.env.PATH = oldPath;
});

const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
});

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A process this test started that is not a daemon at all. */
function decoy(): number {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
	children.push(child);
	assert.ok(child.pid !== undefined && child.pid > 0);
	return child.pid;
}

let pipes = 0;
const pipePath = () => {
	const name = `pcs-cleanup-${process.pid}-${++pipes}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
};

/** How each fake daemon ended: exit code 0 and no signal means it left on its own. */
const exits = new Map<number, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();

/**
 * A process this test started that listens on `socketPath` and greets every client like a CodeGraph daemon,
 * with its own pid or the forged `helloPid`; with `leaveAfterMs` it closes its socket and exits 0 on its own,
 * and with `leaveOnBye` it does so once a client says "bye": a client that needs this test's event loop.
 */
async function fakeDaemon(socketPath: string, helloPid?: number, leaveAfterMs?: number, leaveOnBye = false): Promise<number> {
	const source = [
		`const net = require("node:net");`,
		`const [socketPath, helloPid, leaveAfterMs, leaveOnBye] = process.argv.slice(1);`,
		`const pid = helloPid ? Number(helloPid) : process.pid;`,
		`const leave = () => server.close(() => process.exit(0));`,
		`const server = net.createServer((socket) => {`,
		`  socket.on("error", () => {});`,
		`  socket.on("data", (chunk) => { if (leaveOnBye && String(chunk).includes("bye")) { socket.destroy(); leave(); } });`,
		`  socket.write(JSON.stringify({ codegraph: "1.6.4", pid, socketPath, protocol: 1 }) + "\\n");`,
		`});`,
		`server.listen(socketPath, () => process.stdout.write("ready\\n"));`,
		`if (leaveAfterMs) setTimeout(leave, Number(leaveAfterMs));`,
	].join("\n");
	const args = ["-e", source, socketPath, helloPid === undefined ? "" : String(helloPid), leaveAfterMs === undefined ? "" : String(leaveAfterMs), leaveOnBye ? "1" : ""];
	const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
	children.push(child);
	exits.set(child.pid!, new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))));
	await new Promise<void>((resolve, reject) => {
		child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString("utf8").includes("ready")) resolve(); });
		child.on("exit", (code) => reject(new Error(`fake daemon exited ${code}`)));
	});
	return child.pid!;
}

/** The lock CodeGraph's daemon writes in the project it serves. */
function writeLock(dir: string, lock: { pid: number; socketPath: string; startedAt: number }) {
	mkdirSync(join(dir, ".codegraph"), { recursive: true });
	writeFileSync(join(dir, ".codegraph", "daemon.pid"), JSON.stringify({ ...lock, version: "1.6.4" }));
}

const listed = (pid: number, root: string) => `pid ${pid}  ${root}`;

/** Short waits: on a pass none of these is reached, and a failure must not hang the file. */
const WAIT = { waitMs: 1_500 };

test("cleanup: the daemon of a directory this test created is waited for until it leaves on its own, and is never killed", async () => {
	const dir = ownedDir("pcs-cleanup-own-");
	const socketPath = pipePath();
	const pid = await fakeDaemon(socketPath, undefined, 1_000);
	writeLock(dir, { pid, socketPath, startedAt: Date.now() });
	setListing([]);
	assert.deepEqual(daemonPids(dir), [pid], "the daemon serving the directory is counted");
	await stopDaemon(dir, { waitMs: 10_000 });
	assert.deepEqual(daemonPids(dir), [], "stopDaemon returns only once no daemon serves the directory");
	assert.deepEqual(await exits.get(pid), { code: 0, signal: null }, "the daemon left on its own: nothing killed it");
});

test("cleanup: the wait leaves this test's event loop running, so a client of the daemon in this process can finish and let it leave", async () => {
	// The S15 prefetch test's background warm-ups are such clients: they send their explore call from this
	// process, and the daemon arms its idle timeout only once the last of them is gone.
	const dir = ownedDir("pcs-cleanup-client-");
	const socketPath = pipePath();
	const pid = await fakeDaemon(socketPath, undefined, undefined, true);
	writeLock(dir, { pid, socketPath, startedAt: Date.now() });
	const client = net.createConnection(socketPath);
	client.on("error", () => {});
	await new Promise<void>((resolve) => client.once("data", () => resolve()));
	setTimeout(() => client.write("bye\n"), 200);
	await stopDaemon(dir, { waitMs: 5_000 });
	assert.deepEqual(daemonPids(dir), []);
	assert.deepEqual(await exits.get(pid), { code: 0, signal: null }, "the daemon left on its own: nothing killed it");
	client.destroy();
});

test("cleanup: a process the daemon listing names for exactly this root is not killed when nothing proves it is the daemon", async () => {
	const dir = ownedDir("pcs-cleanup-listed-");
	const pid = decoy();
	setListing([listed(pid, dir)]);
	await stopDaemon(dir, WAIT);
	assert.equal(alive(pid), true, `pid ${pid} was killed on the word of a listing`);
	assert.deepEqual(daemonPids(dir), []);
});

test("cleanup: a daemon listed for a sibling path that only shares the prefix is never selected", async () => {
	const dir = ownedDir("pcs-cleanup-prefix-");
	const pid = decoy();
	setListing([listed(pid, `${dir}-sibling`)]);
	await stopDaemon(dir, WAIT);
	assert.equal(alive(pid), true, `pid ${pid}, listed for ${dir}-sibling, was killed by a partial match`);
	assert.deepEqual(daemonPids(dir), []);
});

test("cleanup: the named-pipe listing finds a pipe this test serves and misses one nobody serves", { skip: process.platform !== "win32" && "named pipes are Windows only" }, async () => {
	const live = pipePath();
	const gone = pipePath();
	await fakeDaemon(live);
	const pipes = listPipes();
	assert.ok("names" in pipes, `this process cannot list named pipes: ${"errors" in pipes ? pipes.errors.join("; ") : ""}`);
	const name = (path: string) => path.slice(path.lastIndexOf(String.fromCharCode(92)) + 1).toLowerCase();
	assert.equal(pipes.names.has(name(live)), true, `the live pipe ${live} is listed`);
	assert.equal(pipes.names.has(name(gone)), false, `the unused pipe ${gone} is not listed`);
});

test("cleanup: a stale lock naming a live process that answers on no socket is not killed", async () => {
	const dir = ownedDir("pcs-cleanup-stale-");
	const pid = decoy();
	writeLock(dir, { pid, socketPath: pipePath(), startedAt: Date.now() });
	setListing([listed(pid, dir)]);
	if (process.platform === "win32" && "errors" in listPipes()) {
		// Where pipes cannot be listed a stale lock cannot be told from a live daemon: it is reported, never gone.
		await assert.rejects(stopDaemon(dir, WAIT), /whether its socket is gone is unknown: named pipes cannot be listed here/);
		assert.equal(alive(pid), true, `pid ${pid} was killed on the word of a stale lock`);
		return;
	}
	await stopDaemon(dir, WAIT);
	assert.equal(alive(pid), true, `pid ${pid} was killed on the word of a stale lock`);
	assert.deepEqual(daemonPids(dir), []);
});

test("cleanup: when the lock names one process and another serves its socket, neither is killed and the wait reports it", async () => {
	const dir = ownedDir("pcs-cleanup-other-");
	const named = decoy();
	const socketPath = pipePath();
	const listener = await fakeDaemon(socketPath);
	writeLock(dir, { pid: named, socketPath, startedAt: Date.now() });
	setListing([listed(named, dir)]);
	await assert.rejects(stopDaemon(dir, WAIT), /left running/);
	assert.equal(alive(named), true, `the pid the lock names (${named}) was killed`);
	assert.equal(alive(listener), true, `the listener (${listener}) was killed`);
});

test("cleanup: a forged greeting that claims another process's pid never gets that process killed", async () => {
	const dir = ownedDir("pcs-cleanup-forged-");
	const victim = decoy();
	const socketPath = pipePath();
	const forger = await fakeDaemon(socketPath, victim);
	writeLock(dir, { pid: victim, socketPath, startedAt: Date.now() });
	setListing([listed(victim, dir)]);
	let refusal: unknown;
	try { await stopDaemon(dir, WAIT); } catch (error) { refusal = error; }
	assert.equal(alive(victim), true, `the victim ${victim}, named by a forged lock and greeting, was killed`);
	assert.equal(alive(forger), true, `the forger ${forger} was killed`);
	assert.match(String(refusal), /left running/, "a daemon that does not leave on its own is reported, not killed");
});

test("cleanup: a daemon that started before this test created the directory is not ours and is not killed", async () => {
	const dir = ownedDir("pcs-cleanup-older-");
	const socketPath = pipePath();
	const pid = await fakeDaemon(socketPath);
	writeLock(dir, { pid, socketPath, startedAt: Date.now() - 60_000 });
	setListing([listed(pid, dir)]);
	await stopDaemon(dir, WAIT);
	assert.equal(alive(pid), true, `pid ${pid} started before the directory existed and was killed`);
	assert.deepEqual(daemonPids(dir), []);
});

test("cleanup: a directory this test process did not create is refused and nothing is killed", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pcs-cleanup-foreign-")));
	const socketPath = pipePath();
	const pid = await fakeDaemon(socketPath);
	writeLock(dir, { pid, socketPath, startedAt: Date.now() });
	setListing([listed(pid, dir)]);
	const refusal = /was not created by this test process/;
	await assert.rejects(stopDaemon(dir, WAIT), refusal);
	assert.throws(() => daemonPids(dir), refusal);
	assert.equal(alive(pid), true, `pid ${pid} in a foreign directory was killed`);
});
