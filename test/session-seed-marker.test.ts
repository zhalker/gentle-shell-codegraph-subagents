import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSessionWorktrees } from "../src/session-seed.ts";
import { readIndexVersionMarker, writeIndexVersionMarker } from "../src/autoindex.ts";

const git = (cwd: string, args: string[]): void => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
};

function repoWithWorktree(): { repo: string; worktree: string; base: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pcs-seed-marker-")));
	const repo = join(base, "repo");
	mkdirSync(repo);
	git(repo, ["init"]);
	writeFileSync(join(repo, "file.txt"), "x" + String.fromCharCode(10));
	git(repo, ["add", "file.txt"]);
	git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
	const worktree = join(base, "wt");
	git(repo, ["worktree", "add", worktree, "-b", "marker-branch"]);
	return { repo, worktree, base };
}

test("a seeded worktree records the source index's version; an unmarked source stays unmarked", async (t) => {
	const { repo, worktree, base } = repoWithWorktree();
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(repo, ".codegraph"));
	writeFileSync(join(repo, ".codegraph", "codegraph.db"), "seed");
	writeFileSync(join(repo, ".codegraph", "indexer-version.json"), JSON.stringify({ version: "1.6.0" }));
	const markers: Array<[string, string]> = [];
	const result = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (_from, to) => { writeFileSync(to, "seed"); return true; },
		run: async () => true,
		readSourceIndexVersion: (root) => readIndexVersionMarker(root, existsSync),
		writeIndexVersion: (root, version) => { markers.push([root, version]); writeIndexVersionMarker(root, version); },
	});
	assert.deepEqual(result.seeded, [join(worktree, ".codegraph", "codegraph.db")]);
	assert.deepEqual(markers.map(([root, version]) => [root.replaceAll("\\", "/"), version]), [[worktree.replaceAll("\\", "/"), "1.6.0"]]);
	assert.equal(readIndexVersionMarker(worktree, existsSync), "1.6.0");
	// An unmarked source leaves the copy unmarked: no version is invented for it.
	const before = markers.length;
	rmSync(join(repo, ".codegraph", "indexer-version.json"));
	const wt2 = join(base, "wt2");
	git(repo, ["worktree", "add", wt2, "-b", "unmarked"]);
	const second = await seedSessionWorktrees({
		cwd: repo,
		exists: existsSync,
		sourceBusy: () => false,
		copy: (_from, to) => { writeFileSync(to, "seed"); return true; },
		run: async () => true,
		readSourceIndexVersion: (root) => readIndexVersionMarker(root, existsSync),
		writeIndexVersion: (root, version) => { markers.push([root, version]); writeIndexVersionMarker(root, version); },
	});
	assert.deepEqual(second.seeded, [join(wt2, ".codegraph", "codegraph.db")]);
	assert.equal(readIndexVersionMarker(wt2, existsSync), undefined);
	assert.equal(markers.length, before, "an unmarked source stays unmarked (no marker write)");
});
