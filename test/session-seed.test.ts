import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSessionWorktrees } from "../src/session-seed.ts";

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

test("a session in the main repo seeds only its unindexed sibling worktrees, in background terms", (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(2);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	// First worktree already indexed: it must be left alone. Second is fresh: seeded.
	mkdirSync(join(worktrees[0]!, ".codegraph"));
	const seeded: string[] = [];
	const result = seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (from, to) => { seeded.push(to); writeFileSync(to, "seed"); return true; },
	});
	assert.deepEqual(result.seeded, [join(worktrees[1]!, ".codegraph", "codegraph.db")], "only the fresh worktree is seeded");
	assert.equal(existsSync(join(worktrees[1]!, ".codegraph", "codegraph.db")), true);
	assert.equal(existsSync(join(worktrees[1]!, ".codegraph", "codegraph.db.seeding")), false, "no staging leftovers");
});

test("a session whose repo has no index seeds nothing", (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const result = seedSessionWorktrees({ cwd: repo, exists: existsSync, sourceBusy: () => false, copy: () => { throw new Error("must not copy"); } });
	assert.deepEqual(result.seeded, []);
});

test("an unwritable or busy main index aborts every seed attempt without touching worktrees", (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(1);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	const result = seedSessionWorktrees({ cwd: repo, exists: existsSync, sourceBusy: () => true, copy: () => { throw new Error("must not copy"); } });
	assert.deepEqual(result.seeded, []);
	assert.equal(existsSync(join(worktrees[0]!, ".codegraph")), false);
});

test("a copy failure in one worktree does not stop the others and leaves nothing half-built", (t) => {
	const { repo, worktrees, base } = repoWithWorktrees(2);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	let attempts = 0;
	const result = seedSessionWorktrees({
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

test("a directory that is not a git repo seeds nothing and never throws", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "session-seed-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const result = seedSessionWorktrees({ cwd: dir, exists: existsSync, sourceBusy: () => false, copy: () => true });
	assert.deepEqual(result.seeded, []);
});
