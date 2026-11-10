import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeOf } from "../src/worktree.ts";

const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "wt-"));
	process.on?.("exit", () => undefined);
	return dir;
};

const git = (cwd: string, args: string): string =>
	execFileSync("git", args.split(" "), { cwd, encoding: "utf8" });

/** A throwaway repo with one commit and a real linked worktree next to it. */
function realWorktree(): { repo: string; worktree: string; base: string } {
	const base = mkdtempSync(join(tmpdir(), "wt-"));
	const repo = join(base, "repo");
	const worktree = join(base, "wt");
	mkdirSync(repo);
	git(repo, "init");
	writeFileSync(join(repo, "file.txt"), "x\n");
	git(repo, "add file.txt");
	git(repo, "-c user.email=t@t -c user.name=t commit -m x");
	git(repo, `worktree add ${worktree} -b wt-branch`);
	return { repo, worktree, base };
}

const cleanup = (t: import("node:test").TestContext, base: string) =>
	t.after(() => rmSync(base, { recursive: true, force: true }));

test("a directory without .git is not a worktree", (t) => {
	const dir = scratch();
	cleanup(t, dir);
	assert.deepEqual(worktreeOf(dir), { worktree: false });
});

test("a plain repository (.git directory) is not a worktree", (t) => {
	const dir = scratch();
	cleanup(t, dir);
	mkdirSync(join(dir, ".git"));
	assert.deepEqual(worktreeOf(dir), { worktree: false });
});

test("a .git file without a gitdir line is not a worktree", (t) => {
	const dir = scratch();
	cleanup(t, dir);
	writeFileSync(join(dir, ".git"), "not a gitdir pointer\n");
	assert.deepEqual(worktreeOf(dir), { worktree: false });
});

test("a .git file whose gitdir does not exist is not a worktree", (t) => {
	const dir = scratch();
	cleanup(t, dir);
	writeFileSync(join(dir, ".git"), "gitdir: C:/definitely/missing/path\n");
	assert.deepEqual(worktreeOf(dir), { worktree: false });
});

test("a real git worktree is detected with the repo as its common root", (t) => {
	const { repo, worktree, base } = realWorktree();
	cleanup(t, base);
	const found = worktreeOf(worktree);
	assert.equal(found.worktree, true, JSON.stringify(found));
	if (found.worktree) assert.equal(found.commonRoot.toLowerCase(), repo.toLowerCase());
});

test("the main repository itself is not reported as a worktree", (t) => {
	const { repo, base } = realWorktree();
	cleanup(t, base);
	assert.deepEqual(worktreeOf(repo), { worktree: false });
});
