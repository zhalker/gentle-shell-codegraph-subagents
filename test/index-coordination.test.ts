// S2/S1: index preparation is one create-or-sync policy, and every write of it goes through the coordination
// the package already has: the per-project index lock and, for syncs, the per-project lease. A request that
// cannot be coordinated is reported as pending or unavailable, never run beside another writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoIndex, seedLinkedWorktrees } from "../src/autoindex.ts";
import type { InitLock } from "../src/initlock.ts";

const CWD = join("some", "repo");
const has = (...present: string[]) => (path: string) => present.some((name) => path.endsWith(name));

/**
 * An index lock that records what it was asked and who holds it: a plain writer, or one whose holder is an
 * init (the caller decided the index belongs to that init and leaves it alone).
 */
function recordingLock(log: string[], held: boolean, initRunning = held): InitLock {
	return {
		acquire: (project, options) => {
			log.push(`acquire:${options?.kind ?? "init"}:${project}`);
			return held
				? { status: "busy" }
				: { status: "acquired", adopt: () => {}, release: () => log.push("release") };
		},
		isHeld: () => {
			log.push("isHeld");
			return held;
		},
		isInitRunning: () => initRunning,
	};
}

test("S2: an existing index is synced under the index lock even without a lease, and the run is reported", async () => {
	const log: string[] = [];
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup", exists: has(".codegraph"),
		lock: recordingLock(log, false),
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
	});
	assert.deepEqual(log, ["isHeld", `acquire:sync:${CWD}`, "run:sync", "release"]);
	assert.deepEqual(result, { action: "sync", ok: true });
});

test("S2: an index locked by another sync leaves the request pending, and it is never reported as synced", async () => {
	const log: string[] = [];
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup", exists: has(".codegraph"),
		// Another session's sync holds the index, not an init: the index exists and only the lease is missing.
		lock: recordingLock(log, true, false),
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
	});
	assert.ok(!log.includes("run:sync"), "nothing was run: the index belongs to another writer");
	assert.deepEqual(result, { action: "sync", ok: true, queued: true });
});

test("S2: create-or-sync names the action it took: init for a fresh project, sync for an existing index", async () => {
	const fresh = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: has(".git", "package.json"), run: async () => true });
	const existing = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: has(".codegraph"), run: async () => true });
	const untouched = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: has(".git"), run: async () => true });
	assert.deepEqual([fresh.action, existing.action, untouched.action], ["init", "sync", "none"]);
});

// --- The session-wide worktree seeding: each worktree under its own index lock ---

/** A repository and one linked worktree of it, built on disk without running git. */
function linkedWorktree(base: string): { repo: string; worktree: string } {
	const repo = join(base, "repo");
	const worktree = join(base, "wt");
	mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
	mkdirSync(worktree);
	writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
	// The main checkout always has an index here: the seed source.
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "main db");
	return { repo, worktree };
}

function scratch(t: import("node:test").TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pcs-linked-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("S2: a linked worktree without an index is seeded under its own index lock, and that lock is released", (t) => {
	const base = scratch(t);
	const { worktree } = linkedWorktree(base);
	const log: string[] = [];
	const result = seedLinkedWorktrees({
		worktrees: [worktree],
		lock: recordingLock(log, false),
		exists: existsSync,
		sourceBusy: () => false,
		copy: (_from, to) => { writeFileSync(to, "seeded db"); return true; },
	});
	assert.deepEqual(result.seeded, [join(worktree, ".codegraph", "codegraph.db")]);
	assert.deepEqual(result.skipped, []);
	assert.deepEqual(log, [`acquire:init:${worktree}`, "release"]);
	assert.equal(existsSync(join(worktree, ".codegraph", "codegraph.db")), true);
});

test("S2: a worktree whose index another session is writing is skipped and never copied into", (t) => {
	const base = scratch(t);
	const { worktree } = linkedWorktree(base);
	let copied = false;
	const result = seedLinkedWorktrees({
		worktrees: [worktree],
		lock: recordingLock([], true),
		exists: existsSync,
		sourceBusy: () => false,
		copy: () => { copied = true; return true; },
	});
	assert.equal(copied, false);
	assert.deepEqual(result.seeded, []);
	assert.deepEqual(result.skipped, [{ worktree, reason: "another session is writing this worktree's index" }]);
	assert.equal(existsSync(join(worktree, ".codegraph")), false, "nothing was created in a worktree this session does not own");
});

test("S2: a worktree that already has an index is skipped without taking any lock", (t) => {
	const base = scratch(t);
	const { worktree } = linkedWorktree(base);
	mkdirSync(join(worktree, ".codegraph"));
	const log: string[] = [];
	const result = seedLinkedWorktrees({
		worktrees: [worktree],
		lock: recordingLock(log, false),
		exists: existsSync,
		sourceBusy: () => false,
		copy: () => { throw new Error("must not copy"); },
	});
	assert.deepEqual(result.skipped, [{ worktree, reason: "already has an index" }]);
	assert.deepEqual(log, []);
});

test("S2: while the main checkout's index is being written, nothing is copied into a worktree", (t) => {
	const base = scratch(t);
	const { worktree } = linkedWorktree(base);
	const result = seedLinkedWorktrees({
		worktrees: [worktree],
		lock: recordingLock([], false),
		exists: existsSync,
		sourceBusy: () => true,
		copy: () => { throw new Error("must not copy"); },
	});
	assert.deepEqual(result.skipped, [{ worktree, reason: "the main checkout's index is being written" }]);
	assert.equal(existsSync(join(worktree, ".codegraph")), false);
});

test("S2: the main checkout itself is never seeded from its own index", (t) => {
	const base = scratch(t);
	const { repo } = linkedWorktree(base);
	const result = seedLinkedWorktrees({
		worktrees: [repo],
		lock: recordingLock([], false),
		exists: existsSync,
		sourceBusy: () => false,
		copy: () => { throw new Error("must not copy"); },
	});
	assert.deepEqual(result, { seeded: [], skipped: [] });
});
