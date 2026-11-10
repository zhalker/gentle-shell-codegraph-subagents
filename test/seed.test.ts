import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorktreeIndex, worktreeIndexAction } from "../src/seed.ts";

const git = (cwd: string, args: string): string =>
	execFileSync("git", args.split(" "), { cwd, encoding: "utf8" });

/** A repo with one commit and a linked worktree: the smallest real fixture for the seeding decision. */
function realWorktree(): { repo: string; worktree: string; base: string } {
	const base = mkdtempSync(join(tmpdir(), "seed-"));
	const repo = join(base, "repo");
	const worktree = join(base, "wt");
	mkdirSync(repo);
	git(repo, "init");
	writeFileSync(join(repo, "file.txt"), "x\n");
	git(repo, "add file.txt");
	git(repo, "-c user.email=t@t -c user.name=t commit -qm x");
	git(repo, `worktree add ${worktree} -b wt-branch`);
	return { repo, worktree, base };
}

const cleanup = (t: import("node:test").TestContext, base: string) =>
	t.after(() => rmSync(base, { recursive: true, force: true }));

test("a worktree whose main repo has an index is seeded, with the main index's db as the source", (t) => {
	const { repo, worktree, base } = realWorktree();
	cleanup(t, base);
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed bytes");
	assert.deepEqual(worktreeIndexAction(worktree, existsSync), { action: "seed", commonRoot: repo });
});

test("a worktree whose main repo has no index falls back to the markers decision", (t) => {
	const { worktree, base } = realWorktree();
	cleanup(t, base);
	// The worktree has no package.json of its own in this fixture, so the existing decision is "none";
	// what matters is that it is NOT "seed" and NOT a worktree-specific action.
	assert.deepEqual(worktreeIndexAction(worktree, existsSync), { action: "none" });
	// A worktree with its own marker file gets the plain init path, same as any fresh git project.
	writeFileSync(join(worktree, "package.json"), "{}\n");
	assert.deepEqual(worktreeIndexAction(worktree, existsSync), { action: "init" });
});

test("a worktree that already has its own index is just synced, never seeded twice", (t) => {
	const { repo, worktree, base } = realWorktree();
	cleanup(t, base);
	mkdirSync(join(repo, ".codegraph"));
	mkdirSync(join(worktree, ".codegraph"));
	assert.deepEqual(worktreeIndexAction(worktree, existsSync), { action: "sync" });
});

test("a plain repository follows the existing markers decision, whatever its main repo state", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "seed-"));
	cleanup(t, dir);
	mkdirSync(join(dir, ".git"));
	// No package.json marker: the existing planIndexAction says "none".
	assert.deepEqual(worktreeIndexAction(dir, existsSync), { action: "none" });
	// With a marker it stays the existing decision (init for a fresh git project).
	writeFileSync(join(dir, "package.json"), "{}\n");
	assert.deepEqual(worktreeIndexAction(dir, existsSync), { action: "init" });
});

test("seeding copies the db only from a main index nobody is writing, into the worktree", (t) => {
	const { repo, worktree, base } = realWorktree();
	cleanup(t, base);
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed bytes");
	const busy: string[] = [];
	const seeded = seedWorktreeIndex({
		worktree,
		commonRoot: repo,
		sourceBusy: () => busy.length > 0,
		copy: (from, to) => {
			busy.push(from);
			writeFileSync(to, "seed bytes");
			return true;
		},
	});
	assert.equal(seeded, true, "seeding ran");
	assert.equal(busy.length, 1, "exactly one copy, of the main index's db");
	assert.ok(busy[0].includes(join(".codegraph", "codegraph.db")), JSON.stringify(busy));
	assert.equal(readOf(join(worktree, ".codegraph", "codegraph.db")), "seed bytes");
});

test("seeding refuses to copy while the main index is being written", (t) => {
	const { repo, worktree, base } = realWorktree();
	cleanup(t, base);
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed bytes");
	const seeded = seedWorktreeIndex({ worktree, commonRoot: repo, sourceBusy: () => true, copy: () => { throw new Error("must not copy"); } });
	assert.equal(seeded, false);
	assert.equal(existsSync(join(worktree, ".codegraph")), false, "nothing half-seeded");
});

test("a failed copy leaves no half-built index in the worktree", (t) => {
	const { repo, worktree, base } = realWorktree();
	cleanup(t, base);
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed bytes");
	const seeded = seedWorktreeIndex({ worktree, commonRoot: repo, sourceBusy: () => false, copy: () => false });
	assert.equal(seeded, false);
	assert.equal(existsSync(join(worktree, ".codegraph")), false);
});

function readOf(file: string): string {
	return readFileSync(file, "utf8");
}
