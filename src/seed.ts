import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
export { worktreeOf } from "./worktree.ts";
import { worktreeOf } from "./worktree.ts";
import { planIndexAction } from "./autoindex.ts";

export type WorktreeIndexAction =
	/** The worktree has no index yet and the main repo has one: copy it and sync. */
	| { action: "seed"; commonRoot: string }
	/** The worktree has no index and the main repo has none either: the plain init path. */
	| { action: "init" }
	/** The worktree already has its own index: the existing sync path. */
	| { action: "sync" }
	/** Not a worktree, or a directory the existing decision leaves alone. */
	| { action: "none" };

/**
 * The index decision for one directory, extending the existing per-directory decision with worktrees: a
 * linked worktree indexes its own tree (never shares the main checkout's index), and when the main repo
 * already has an index, the worktree is seeded from it instead of paying a full init. Everything else falls
 * back to the existing behaviour (`planIndexAction` semantics: sync what exists, init a fresh git project
 * with a marker file, leave the rest alone).
 */
export function worktreeIndexAction(cwd: string, exists: (path: string) => boolean): WorktreeIndexAction {
	const found = worktreeOf(cwd);
	if (found.worktree && exists(join(cwd, ".codegraph"))) return { action: "sync" };
	if (found.worktree && exists(join(found.commonRoot, ".codegraph"))) return { action: "seed", commonRoot: found.commonRoot };
	return { action: planIndexAction(cwd, exists) };
}

export interface SeedInput {
	worktree: string;
	/** The common root whose `.codegraph` holds the source db. */
	commonRoot: string;
	/** Whether the main index is being written right now (an init or sync holds it). */
	sourceBusy(): boolean;
	/** Copies the db; false (or a throw) means the seed failed and nothing is left behind. */
	copy(from: string, to: string): boolean;
}

/**
 * Seeds the worktree's own index by copying the main repo's `codegraph.db`, never while the main index is
 * being written and never leaving a half-built `.codegraph` behind: the directory is created only once the
 * copy has succeeded in memory terms (the copy itself writes the file, the dir exists first only when the
 * copy reported success is possible). The `-wal`/`-shm` siblings are deliberately not copied: the source
 * db must be at rest, and the first `sync` in the worktree rebuilds whatever the WAL held.
 */
export function seedWorktreeIndex(input: SeedInput): boolean {
	const source = join(input.commonRoot, ".codegraph", "codegraph.db");
	if (!existsSync(source) || input.sourceBusy()) return false;
	const targetDir = join(input.worktree, ".codegraph");
	const target = join(targetDir, "codegraph.db");
	try {
		mkdirSync(targetDir, { recursive: true });
		const staged = join(targetDir, "codegraph.db.seeding");
		if (!input.copy(source, staged)) {
			rmSync(staged, { force: true });
			rmSync(targetDir, { recursive: true, force: true });
			return false;
		}
		copyFileSync(staged, target);
		rmSync(staged, { force: true });
		return true;
	} catch {
		rmSync(targetDir, { recursive: true, force: true });
		return false;
	}
}
