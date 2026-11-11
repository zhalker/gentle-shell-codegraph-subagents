import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { worktreeOf } from "./worktree.ts";
import { seedWorktreeIndex } from "./seed.ts";

export interface SessionSeedResult {
	/** The worktree db files that were seeded, one per worktree that lacked an index. */
	seeded: string[];
	/** Worktrees that were skipped, with why (already indexed, unsuitable, or a failed copy). */
	skipped: { worktree: string; reason: string }[];
}

/** Lists the linked worktrees of the repo that `cwd` belongs to, via one short `git worktree list`. */
function siblingWorktrees(cwd: string): string[] {
	const found = worktreeOf(cwd);
	const repoRoot = found.worktree ? found.commonRoot : cwd;
	const run = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
	if (run.status !== 0 || typeof run.stdout !== "string") return [];
	const roots: string[] = [];
	for (const line of run.stdout.split("\n")) {
		if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length).trim());
	}
	return roots;
}

/**
 * Seeds the unindexed linked worktrees of this session's repository, so the index exists before the first
 * subagent child is handed the worktree as its `workspace_root`. One `git worktree list` from the session's
 * repo, then the same seeding decision as everywhere else: a worktree that already has an index, or whose
 * main repo has none, is left alone; every copy runs under the existing locks and never leaves a half-built
 * index behind. Runs in the background of the parent's session start; the session never waits for it.
 */
export function seedSessionWorktrees(input: {
	cwd: string;
	exists(path: string): boolean;
	sourceBusy(): boolean;
	copy(from: string, to: string): boolean;
}): SessionSeedResult {
	try {
		const mainIndex = join(input.cwd, ".codegraph", "codegraph.db");
		if (!input.exists(mainIndex) || input.sourceBusy()) return { seeded: [], skipped: [{ worktree: input.cwd, reason: "the session's own index is missing or being written" }] };
		const result: SessionSeedResult = { seeded: [], skipped: [] };
		for (const root of siblingWorktrees(input.cwd)) {
			try {
				const wt = worktreeOf(root);
				if (!wt.worktree) continue; // the main checkout and non-worktree roots are not our business here
				if (input.exists(join(root, ".codegraph"))) { result.skipped.push({ worktree: root, reason: "already has an index" }); continue; }
				const seeded = seedWorktreeIndex({ worktree: root, commonRoot: wt.commonRoot, sourceBusy: input.sourceBusy, copy: input.copy });
				if (seeded) result.seeded.push(join(root, ".codegraph", "codegraph.db"));
				else result.skipped.push({ worktree: root, reason: "the seed copy failed" });
			} catch (error) {
				result.skipped.push({ worktree: root, reason: `unexpected: ${(error as Error).message}` });
			}
		}
		return result;
	} catch {
		return { seeded: [], skipped: [] };
	}
}
