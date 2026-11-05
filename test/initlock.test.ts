import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_MAX_AGE_MS, PROXY_TRUST_MS, isInitLocked, tryAcquireInitLock } from "../src/initlock.ts";

function scratch(): { dir: string; project: string } {
	return {
		dir: realpathSync(mkdtempSync(join(tmpdir(), "pcs-locks-"))),
		project: realpathSync(mkdtempSync(join(tmpdir(), "pcs-project-"))),
	};
}

const lockEntries = (dir: string) => readdirSync(dir).filter((entry) => entry.startsWith("pcs-init-"));

test("S17: the first session gets the lock, a second one finds it busy, and releasing frees it", () => {
	const { dir, project } = scratch();
	const first = tryAcquireInitLock(project, { dir });
	assert.equal(first.status, "acquired");
	assert.equal(isInitLocked(project, { dir }), true);
	assert.deepEqual(tryAcquireInitLock(project, { dir }), { status: "busy" });
	if (first.status === "acquired") first.release();
	assert.equal(isInitLocked(project, { dir }), false);
	assert.deepEqual(lockEntries(dir), []);
	const again = tryAcquireInitLock(project, { dir });
	assert.equal(again.status, "acquired");
	if (again.status === "acquired") again.release();
});

test("S17: without a lock nothing reads as locked", () => {
	const { dir, project } = scratch();
	assert.equal(isInitLocked(project, { dir }), false);
});

test("S17: different projects have independent locks", () => {
	const { dir, project } = scratch();
	const other = scratch().project;
	const a = tryAcquireInitLock(project, { dir });
	const b = tryAcquireInitLock(other, { dir });
	assert.equal(a.status, "acquired");
	assert.equal(b.status, "acquired");
	assert.equal(isInitLocked(other, { dir }), true);
	if (a.status === "acquired") a.release();
	assert.equal(isInitLocked(other, { dir }), true);
	if (b.status === "acquired") b.release();
});

test("S17: the same project spelled differently shares one lock (trailing separator; letter case on Windows)", () => {
	const { dir, project } = scratch();
	const held = tryAcquireInitLock(project, { dir });
	assert.equal(held.status, "acquired");
	const spellings = [project + (process.platform === "win32" ? "\\" : "/"), ...(process.platform === "win32" ? [project.toUpperCase(), project.toLowerCase()] : [])];
	for (const spelling of spellings) {
		assert.deepEqual(tryAcquireInitLock(spelling, { dir }), { status: "busy" }, spelling);
		assert.equal(isInitLocked(spelling, { dir }), true, spelling);
	}
	if (held.status === "acquired") held.release();
});

test("S17: a lock whose process is gone is stale: the next session takes it over", () => {
	const { dir, project } = scratch();
	const dead = tryAcquireInitLock(project, { dir });
	assert.equal(dead.status, "acquired");
	assert.equal(isInitLocked(project, { dir, isAlive: () => false }), false);
	const taken = tryAcquireInitLock(project, { dir, isAlive: () => false });
	assert.equal(taken.status, "acquired");
	if (taken.status === "acquired") taken.release();
});

test("S17: a lock older than the longest an init can run is stale even if its pid looks alive", () => {
	const { dir, project } = scratch();
	const held = tryAcquireInitLock(project, { dir, now: () => Date.now() - LOCK_MAX_AGE_MS - 1_000 });
	assert.equal(held.status, "acquired");
	assert.equal(isInitLocked(project, { dir, isAlive: () => true }), false);
	const taken = tryAcquireInitLock(project, { dir, isAlive: () => true });
	assert.equal(taken.status, "acquired");
	if (taken.status === "acquired") taken.release();
});

test("S17: a lock directory that is still being written counts as held; an abandoned one does not", () => {
	const { dir, project } = scratch();
	const held = tryAcquireInitLock(project, { dir });
	assert.equal(held.status, "acquired");
	const lockDir = join(dir, lockEntries(dir)[0]);
	if (held.status === "acquired") held.release();
	mkdirSync(lockDir);
	assert.equal(isInitLocked(project, { dir }), true, "fresh and empty: the owner has not written its record yet");
	const longAgo = new Date(Date.now() - 120_000);
	utimesSync(lockDir, longAgo, longAgo);
	assert.equal(isInitLocked(project, { dir }), false, "empty for two minutes: abandoned");
	const taken = tryAcquireInitLock(project, { dir });
	assert.equal(taken.status, "acquired");
	if (taken.status === "acquired") taken.release();
});

test("S17: a damaged owner record is treated like an abandoned lock once it is old enough", () => {
	const { dir, project } = scratch();
	const held = tryAcquireInitLock(project, { dir });
	assert.equal(held.status, "acquired");
	const lockDir = join(dir, lockEntries(dir)[0]);
	writeFileSync(join(lockDir, "owner.json"), "not json");
	const longAgo = new Date(Date.now() - 120_000);
	utimesSync(lockDir, longAgo, longAgo);
	assert.equal(isInitLocked(project, { dir }), false);
});

test("S17: releasing never removes a lock that now belongs to someone else", () => {
	const { dir, project } = scratch();
	const mine = tryAcquireInitLock(project, { dir });
	assert.equal(mine.status, "acquired");
	const taken = tryAcquireInitLock(project, { dir, isAlive: () => false });
	assert.equal(taken.status, "acquired");
	if (mine.status === "acquired") mine.release();
	assert.equal(isInitLocked(project, { dir }), true, "the new owner's lock must survive the old owner's release");
	if (taken.status === "acquired") taken.release();
});

test("S17: an unusable lock directory never throws: the session simply goes on as if it had the lock", () => {
	const project = scratch().project;
	const attempt = tryAcquireInitLock(project, { dir: join(tmpdir(), "pcs-does-not-exist", "nor-this") });
	assert.equal(attempt.status, "acquired");
	if (attempt.status === "acquired") attempt.release();
	assert.equal(isInitLocked(project, { dir: join(tmpdir(), "pcs-does-not-exist", "nor-this") }), false);
});

function sessionTaking(dir: string, project: string, startAt: number, holdMs: number): Promise<{ status: string; pid: number }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(import.meta.dirname, "lock-worker.ts"), dir, project, String(startAt), String(holdMs)], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.on("close", () => {
			try { resolve(JSON.parse(out.trim().split("\n")[0])); } catch { resolve({ status: `worker produced no result: ${out.slice(0, 80)}`, pid: 0 }); }
		});
	});
}

test("S17: sessions that try at the very same instant: exactly one gets the lock, every time", async () => {
	for (const sessions of [2, 4, 6]) {
		for (let round = 0; round < 4; round++) {
			const { dir, project } = scratch();
			const startAt = Date.now() + 800;
			const results = await Promise.all(Array.from({ length: sessions }, () => sessionTaking(dir, project, startAt, 300)));
			const winners = results.filter((result) => result.status === "acquired").length;
			const busy = results.filter((result) => result.status === "busy").length;
			assert.deepEqual({ winners, busy }, { winners: 1, busy: sessions - 1 }, `${sessions} sessions, round ${round}: ${JSON.stringify(results)}`);
			assert.deepEqual(lockEntries(dir), [], `${sessions} sessions, round ${round}: the winner released the lock`);
		}
	}
});

test("S17: a holder that is killed leaves a lock the next session recognises as stale", async () => {
	const { dir, project } = scratch();
	const child = spawn(process.execPath, [join(import.meta.dirname, "lock-worker.ts"), dir, project, "0", "60000"], { stdio: ["ignore", "pipe", "ignore"] });
	await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
	assert.equal(isInitLocked(project, { dir }), true);
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("close", resolve));
	assert.equal(existsSync(join(dir, lockEntries(dir)[0])), true, "a killed process cannot clean up after itself");
	assert.equal(isInitLocked(project, { dir }), false);
	const taken = tryAcquireInitLock(project, { dir });
	assert.equal(taken.status, "acquired");
	if (taken.status === "acquired") taken.release();
});

test("S18: two sessions that both find the same stale lock: only one of them takes it over", () => {
	const { dir, project } = scratch();
	const old = tryAcquireInitLock(project, { dir, now: () => Date.now() - LOCK_MAX_AGE_MS - 1_000 });
	assert.equal(old.status, "acquired");
	let rival: ReturnType<typeof tryAcquireInitLock> | undefined;
	// The rival runs its whole attempt right after this session judged the lock stale and before it cleared it.
	const mine = tryAcquireInitLock(project, { dir, onStale: () => { rival ??= tryAcquireInitLock(project, { dir }); } });
	assert.ok(rival, "the race window was reached");
	assert.deepEqual([mine.status, rival.status].sort(), ["acquired", "busy"]);
	assert.equal(isInitLocked(project, { dir }), true);
	for (const attempt of [mine, rival]) if (attempt.status === "acquired") attempt.release();
	assert.deepEqual(lockEntries(dir), [], "the winner's release leaves nothing behind, takeover guard included");
});

test("S18: a takeover guard left by a session that died mid-takeover does not block the lock for good", () => {
	const { dir, project } = scratch();
	const old = tryAcquireInitLock(project, { dir, now: () => Date.now() - LOCK_MAX_AGE_MS - 1_000 });
	assert.equal(old.status, "acquired");
	const guard = join(dir, `${lockEntries(dir)[0]}.takeover`);
	mkdirSync(guard);
	assert.deepEqual(tryAcquireInitLock(project, { dir }), { status: "busy" }, "a fresh guard: someone is taking over right now");
	const longAgo = new Date(Date.now() - 60_000);
	utimesSync(guard, longAgo, longAgo);
	let taken = tryAcquireInitLock(project, { dir });
	if (taken.status === "busy") taken = tryAcquireInitLock(project, { dir });
	assert.equal(taken.status, "acquired");
	if (taken.status === "acquired") taken.release();
	assert.deepEqual(lockEntries(dir), []);
});

test("S18: the lock stays held while the init process lives, even when the session that took it is gone", () => {
	const { dir, project } = scratch();
	const held = tryAcquireInitLock(project, { dir });
	assert.equal(held.status, "acquired");
	if (held.status !== "acquired") return;
	held.adopt(424242);
	assert.equal(isInitLocked(project, { dir, isAlive: (pid) => pid === 424242 }), true, "session gone, init alive");
	assert.equal(isInitLocked(project, { dir, isAlive: (pid) => pid === process.pid }), true, "session alive");
	assert.equal(isInitLocked(project, { dir, isAlive: () => false }), false, "both gone");
	assert.deepEqual(tryAcquireInitLock(project, { dir, isAlive: (pid) => pid === 424242 }), { status: "busy" });
	held.release();
	assert.deepEqual(lockEntries(dir), []);
});

test("S18 real: a session that exits while its init process goes on leaves the lock held until that process ends", async () => {
	const { dir, project } = scratch();
	const out = await new Promise<string>((resolve) => {
		const child = spawn(process.execPath, [join(import.meta.dirname, "lock-worker.ts"), dir, project, "0", "30000", "orphan"], { stdio: ["ignore", "pipe", "ignore"] });
		let text = "";
		child.stdout.on("data", (chunk) => (text += chunk));
		child.on("close", () => resolve(text));
	});
	const { status, initPid } = JSON.parse(out.trim());
	assert.equal(status, "acquired");
	try {
		assert.equal(isInitLocked(project, { dir }), true, "the session is gone but its init is not");
		assert.deepEqual(tryAcquireInitLock(project, { dir }), { status: "busy" });
	} finally {
		process.kill(initPid);
	}
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(isInitLocked(project, { dir }), false, "once the init is gone too, the lock is stale");
});

test("S18: the adopted pid is written atomically: a reader never sees the record vanish", () => {
	const { dir, project } = scratch();
	const held = tryAcquireInitLock(project, { dir });
	assert.equal(held.status, "acquired");
	if (held.status !== "acquired") return;
	for (let i = 0; i < 200; i++) {
		held.adopt(1000 + i);
		assert.equal(isInitLocked(project, { dir, isAlive: (pid) => pid === 1000 + i }), true, `round ${i}`);
	}
	assert.deepEqual(readdirSync(join(dir, lockEntries(dir)[0])), ["owner.json"], "no temporary files left behind");
	held.release();
});

test("S18: a record that adopted the init process itself is stale as soon as that process is gone", () => {
	const { dir, project } = scratch();
	const start = Date.now();
	const held = tryAcquireInitLock(project, { dir, now: () => start });
	assert.equal(held.status, "acquired");
	if (held.status !== "acquired") return;
	held.adopt(424242);
	// Nothing to wait for: the pid that was adopted is the process that does the work.
	assert.equal(isInitLocked(project, { dir, isAlive: () => false, now: () => start + 1 }), false);
	const taken = tryAcquireInitLock(project, { dir, isAlive: () => false, now: () => start + 1 });
	assert.equal(taken.status, "acquired");
	if (taken.status === "acquired") taken.release();
	held.release();
});

test("S18: while a CodeGraph process writes the index, the lock stays held whatever pid the session adopted", () => {
	const { dir, project } = scratch();
	const held = tryAcquireInitLock(project, { dir });
	assert.equal(held.status, "acquired");
	if (held.status !== "acquired") return;
	// The pid this session adopted was the shell, and it is gone; the init itself goes on and says so in
	// CodeGraph's own lock, which is the pid that decides.
	held.adopt(424242, { proxy: true });
	mkdirSync(join(project, ".codegraph"), { recursive: true });
	writeFileSync(join(project, ".codegraph", "codegraph.lock"), String(process.pid));
	assert.equal(isInitLocked(project, { dir, isAlive: () => false }), true, "the init is alive, the session and its shell are not");
	assert.deepEqual(tryAcquireInitLock(project, { dir, isAlive: () => false }), { status: "busy" });
	held.release();
	assert.equal(isInitLocked(project, { dir }), false, "the record is gone: CodeGraph's lock alone never holds it");
});

test("S18: right after a shell spawned the init, before CodeGraph writes its own lock, the record is still trusted", () => {
	const { dir, project } = scratch();
	const start = Date.now();
	const held = tryAcquireInitLock(project, { dir, now: () => start });
	assert.equal(held.status, "acquired");
	if (held.status !== "acquired") return;
	held.adopt(424242, { proxy: true });
	const dead = { isAlive: () => false };
	assert.equal(isInitLocked(project, { dir, ...dead, now: () => start + 1_000 }), true, "the shell died and the init has not shown up yet");
	assert.deepEqual(tryAcquireInitLock(project, { dir, ...dead, now: () => start + 1_000 }), { status: "busy" });
	const later = start + PROXY_TRUST_MS + 1;
	assert.equal(isInitLocked(project, { dir, ...dead, now: () => later }), false, "after that window no init ever showed up: stale");
	const taken = tryAcquireInitLock(project, { dir, ...dead, now: () => later });
	assert.equal(taken.status, "acquired");
	if (taken.status === "acquired") taken.release();
	held.release();
});

const waitUntilGone = async (pid: number, deadlineMs: number): Promise<boolean> => {
	const until = Date.now() + deadlineMs;
	while (Date.now() < until) {
		try { process.kill(pid, 0); } catch { return true; }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
};

test("S18 real: the shell of a spawned init dies while the init goes on: the lock stays held and no session takes it over", async () => {
	const { dir, project } = scratch();
	const out = await new Promise<string>((resolve) => {
		const child = spawn(process.execPath, [join(import.meta.dirname, "lock-worker.ts"), dir, project, "0", "30000", "shell"], { stdio: ["ignore", "pipe", "ignore"] });
		let text = "";
		child.stdout.on("data", (chunk) => (text += chunk));
		child.on("close", () => resolve(text));
	});
	const { status, initPid: shellPid } = JSON.parse(out.trim());
	assert.equal(status, "acquired");
	let initPid = 0;
	try { initPid = Number(readFileSync(join(project, ".codegraph", "codegraph.lock"), "utf8")); } catch { /* reported below */ }
	assert.ok(initPid > 0, `the init announced itself in CodeGraph's own lock: ${out.trim()}`);
	try {
		// The session is gone. On Windows its shell went with it; elsewhere the Pi that owned it would kill it.
		if (!(await waitUntilGone(shellPid, 10_000))) process.kill(shellPid);
		assert.ok(await waitUntilGone(shellPid, 5_000), "the shell really is gone");
		process.kill(initPid, 0);
		assert.equal(isInitLocked(project, { dir }), true, "nobody is left to speak for the lock but the init itself");
		assert.deepEqual(tryAcquireInitLock(project, { dir }), { status: "busy" }, "a new session must not start a second init");
	} finally {
		try { process.kill(initPid); } catch { /* it is gone already */ }
	}
	assert.ok(await waitUntilGone(initPid, 10_000), "the init is gone too");
	assert.equal(isInitLocked(project, { dir }), true, "its pid is no longer alive, but the shell was never proof of death");
	assert.equal(isInitLocked(project, { dir, now: () => Date.now() + PROXY_TRUST_MS + 1_000 }), false, "past that window the lock is stale again");
});
