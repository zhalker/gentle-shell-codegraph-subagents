import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSessionWorktrees } from "../src/session-seed.ts";
import { SYNC_TIMEOUT_MS } from "../src/autoindex.ts";
import type { InitLock } from "../src/initlock.ts";

const git = (cwd: string, args: string[]): void => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
};

function repoWithWorktrees(count: number): { repo: string; worktrees: string[]; base: string } {
	const base = mkdtempSync(join(tmpdir(), "session-seed-"));
	const repo = join(base, "repo");
	mkdirSync(repo);
	git(repo, ["init"]);
	writeFileSync(join(repo, "file.txt"), "x\n");
	git(repo, ["add", "file.txt"]);
	git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
	const worktrees: string[] = [];
	for (let i = 0; i < count; i++) {
		const wt = join(base, `wt${i}`);
		git(repo, ["worktree", "add", wt, "-b", `branch${i}`]);
		worktrees.push(wt);
	}
	return { repo, worktrees, base };
}

test("a session in the main repo seeds only its unindexed sibling worktrees, in background terms", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(2);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	// First worktree already indexed: it must be left alone. Second is fresh: seeded.
	mkdirSync(join(worktrees[0]!, ".codegraph"));
	const seeded: string[] = [];
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (from, to) => { seeded.push(to); writeFileSync(to, "seed"); return true; },
	});
	assert.deepEqual(result.seeded, [join(worktrees[1]!, ".codegraph", "codegraph.db")], "only the fresh worktree is seeded");
	assert.equal(existsSync(join(worktrees[1]!, ".codegraph", "codegraph.db")), true);
	assert.equal(existsSync(join(worktrees[1]!, ".codegraph", "codegraph.db.seeding")), false, "no staging leftovers");
});

test("a session whose repo has no index seeds nothing", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const result = await seedSessionWorktrees({ cwd: repo, exists: existsSync, sourceBusy: () => false, copy: () => { throw new Error("must not copy"); } });
	assert.deepEqual(result.seeded, []);
});

test("an unwritable or busy main index aborts every seed attempt without touching worktrees", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	const result = await seedSessionWorktrees({ cwd: repo, exists: existsSync, sourceBusy: () => true, copy: () => { throw new Error("must not copy"); } });
	assert.deepEqual(result.seeded, []);
	assert.equal(existsSync(join(worktrees[0]!, ".codegraph")), false);
});

test("a copy failure in one worktree does not stop the others and leaves nothing half-built", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(2);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	let attempts = 0;
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (_from, to) => {
			attempts++;
			if (attempts === 1) return false; // first worktree fails
			writeFileSync(to, "seed");
			return true;
		},
	});
	assert.equal(result.seeded.length, 1, "the second worktree was still seeded");
	assert.equal(existsSync(join(worktrees[0]!, ".codegraph")), false, "the failed one left nothing");
});

test("a directory that is not a git repo seeds nothing and never throws", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "session-seed-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const result = await seedSessionWorktrees({ cwd: dir, exists: existsSync, sourceBusy: () => false, copy: () => true });
	assert.deepEqual(result.seeded, []);
});

test("a copied seed is only counted as seeded once its sync succeeded", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	const runs: { args: string[]; cwd: string; timeoutMs: number }[] = [];
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (from, to) => { writeFileSync(to, "seed"); return true; },
		run: (args, cwd, timeoutMs) => { runs.push({ args, cwd, timeoutMs }); return Promise.resolve(true); },
	});
	assert.deepEqual(result.seeded, [join(worktrees[0]!, ".codegraph", "codegraph.db")], "copy plus sync counts as seeded");
	assert.deepEqual(result.skipped, []);
	assert.deepEqual(runs, [{ args: ["sync", "-q"], cwd: worktrees[0]!.replaceAll("\\", "/"), timeoutMs: SYNC_TIMEOUT_MS }], "one sync in the worktree, with the package's sync timeout");
});

test("a seed whose sync failed is not seeded, says why and removes the copied index", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (from, to) => { writeFileSync(to, "seed"); return true; },
		run: () => Promise.resolve(false),
	});
	assert.deepEqual(result.seeded, [], "the copied db still holds the main checkout's data, so it is not seeded");
	assert.deepEqual(result.skipped, [{ worktree: worktrees[0]!.replaceAll("\\", "/"), reason: "the seed sync failed" }]);
	// The half-built index is gone, so a later child initializes the worktree fresh instead of answering from the
	// main checkout's data.
	assert.equal(existsSync(join(worktrees[0]!, ".codegraph")), false, "the copied index was removed after the failed sync");
});

/** A lock double that records what the seeding does with it; `busy` stands for another session's writer. */
function fakeLock(log: string[], busy = false): InitLock {
	return {
		acquire: (project) => {
			log.push(`acquire:${project}`);
			if (busy) return { status: "busy" };
			return {
				status: "acquired",
				adopt: (pid, options) => { log.push(`adopt:${pid}${options?.proxy === true ? ":proxy" : ""}`); },
				release: () => { log.push(`release:${project}`); },
			};
		},
		isHeld: () => false,
		isInitRunning: () => false,
	};
}

test("a worktree another session is writing is skipped under the coordination and nothing runs there", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	const log: string[] = [];
	const copies: string[] = [];
	const runs: string[] = [];
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (_from, to) => { copies.push(to); writeFileSync(to, "seed"); return true; },
		run: (args) => { runs.push(args.join(" ")); return Promise.resolve(true); },
		lock: fakeLock(log, true),
	});
	const wt = worktrees[0]!.replaceAll("\\", "/");
	assert.deepEqual(result.seeded, []);
	assert.deepEqual(result.skipped, [{ worktree: wt, reason: "another session is writing this worktree's index" }]);
	assert.deepEqual(log, [`acquire:${wt}`], "a busy lock is never adopted or released");
	assert.deepEqual(copies, [], "nothing is copied while another session writes the worktree");
	assert.deepEqual(runs, [], "no sync is started while another session writes the worktree");
	assert.equal(existsSync(join(worktrees[0]!, ".codegraph")), false);
});

test("a seeded worktree holds the package's index lock, adopts the spawned pid and releases the lock", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	const log: string[] = [];
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (_from, to) => { log.push("copy"); writeFileSync(to, "seed"); return true; },
		run: (args, cwd, timeoutMs, onSpawn) => {
			log.push(`run:${args.join(" ")}:${cwd}:${timeoutMs}`);
			onSpawn?.(4242, { proxy: true });
			return Promise.resolve(true);
		},
		lock: fakeLock(log),
	});
	const wt = worktrees[0]!.replaceAll("\\", "/");
	assert.deepEqual(result.seeded, [join(worktrees[0]!, ".codegraph", "codegraph.db")]);
	assert.deepEqual(log, [`acquire:${wt}`, "copy", `run:sync -q:${wt}:${SYNC_TIMEOUT_MS}`, "adopt:4242:proxy", `release:${wt}`], "the lock covers the copy and the sync, and the spawned pid is adopted inside it");
});

test("a failed copy releases the lock and starts no sync", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	const log: string[] = [];
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: () => false,
		run: () => { log.push("run"); return Promise.resolve(true); },
		lock: fakeLock(log),
	});
	const wt = worktrees[0]!.replaceAll("\\", "/");
	assert.deepEqual(result.seeded, []);
	assert.deepEqual(result.skipped, [{ worktree: wt, reason: "the seed copy failed" }]);
	assert.deepEqual(log, [`acquire:${wt}`, `release:${wt}`]);
	assert.equal(existsSync(join(worktrees[0]!, ".codegraph")), false);
});

test("a seed with no run callback stays copy-only and still counts as seeded", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (from, to) => { writeFileSync(to, "seed"); return true; },
	});
	assert.deepEqual(result.seeded, [join(worktrees[0]!, ".codegraph", "codegraph.db")]);
	assert.deepEqual(result.skipped, []);
});

test("a worktree that gained an index while the seed waited for its lock is skipped, its index untouched", async (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	// Another session completes its init and releases the lock between the outer check and this seed's
	// acquire: its index appears exactly when this seed acquires, so only the in-lock recheck can still see it.
	const copies: string[] = [];
	const runs: string[] = [];
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: (path) => existsSync(path), // the stub acquire creates the index before the recheck reads it
		sourceBusy: () => false,
		copy: (from, to) => { copies.push(to); writeFileSync(to, "stale-seed"); return true; },
		lock: {
			acquire: (project) => {
				const dir = join(String(project), ".codegraph");
				mkdirSync(dir, { recursive: true }); // the other session's completed init, seen at acquire time
				writeFileSync(join(dir, "codegraph.db"), "other-session");
				return { status: "acquired", adopt: () => {}, release: () => {} };
			},
			isHeld: () => false,
		},
		run: async () => { runs.push("sync"); return true; },
	});
	assert.deepEqual(result.seeded, [], "a worktree whose index appeared before the copy is not seeded");
	assert.deepEqual(copies, [], "the finished index is not overwritten by the seed copy");
	assert.deepEqual(runs, [], "no sync runs against the finished index");
	assert.deepEqual(result.skipped, [{ worktree: worktrees[0]!.replaceAll("\\", "/"), reason: "already has an index" }]);
});
