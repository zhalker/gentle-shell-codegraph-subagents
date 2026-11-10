import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoIndex } from "../src/autoindex.ts";

const git = (cwd: string, args: string): string =>
	execFileSync("git", args.split(" "), { cwd, encoding: "utf8" });

function realWorktree(): { repo: string; worktree: string; base: string } {
	const base = mkdtempSync(join(tmpdir(), "child-"));
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

const CHILD = { GENTLE_PI_AGENTS_CHILD: "1" };

test("S-T6: a subagent child in a worktree without an index seeds it and syncs its own tree", async (t) => {
	const { repo, worktree, base } = realWorktree();
	cleanup(t, base);
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed bytes");
	const runs: string[][] = [];
	const result = await autoIndex({
		cwd: worktree,
		env: CHILD,
		reason: "new",
		exists: existsSync,
		run: async (args) => { runs.push(args); return true; },
		copySeed: (from, to) => { writeFileSync(to, "seed bytes"); return true; },
	});
	assert.deepEqual(result, { action: "seed", ok: true });
	assert.equal(existsSync(join(worktree, ".codegraph", "codegraph.db")), true, "the worktree has its own index");
	assert.deepEqual(runs, [["sync", "-q"]], "one sync of the worktree, never an init");
});

test("S-T6: a subagent child in a directory with an index does nothing new (normal children unchanged)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "child-"));
	cleanup(t, dir);
	mkdirSync(join(dir, ".codegraph"));
	mkdirSync(join(dir, ".git"));
	const runs: string[][] = [];
	const result = await autoIndex({
		cwd: dir,
		env: CHILD,
		reason: "new",
		exists: existsSync,
		run: async (args) => { runs.push(args); return true; },
	});
	assert.deepEqual(result, { action: "none", ok: true });
	assert.deepEqual(runs, [], "a child never syncs the shared project of its parent");
});

test("S-T6: a subagent child in a worktree whose main repo has no index takes the plain init path", async (t) => {
	const { worktree, base } = realWorktree();
	cleanup(t, base);
	writeFileSync(join(worktree, "package.json"), "{}\n");
	const runs: string[][] = [];
	const result = await autoIndex({
		cwd: worktree,
		env: CHILD,
		reason: "new",
		exists: existsSync,
		run: async (args) => { runs.push(args); return true; },
	});
	assert.deepEqual(result, { action: "init", ok: true });
	assert.deepEqual(runs, [["init", "-y"]]);
});

test("S-T6: a subagent child in a plain directory without a marker creates nothing", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "child-"));
	cleanup(t, dir);
	const result = await autoIndex({
		cwd: dir,
		env: CHILD,
		reason: "new",
		exists: existsSync,
		run: async () => { throw new Error("must not run"); },
	});
	assert.deepEqual(result, { action: "none", ok: true });
});
