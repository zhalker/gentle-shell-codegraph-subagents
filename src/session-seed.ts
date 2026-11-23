import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { worktreeOf } from "./worktree.ts";
import { seedWorktreeIndex } from "./seed.ts";
import { SYNC_TIMEOUT_MS } from "./autoindex.ts";
import { codegraphWritingIndex, type InitLock } from "./initlock.ts";

export interface SessionSeedResult {
	/** The worktree db files that were seeded and then synced, one per worktree that lacked an index. */
	seeded: string[];
	/** Worktrees that were skipped, with why (already indexed, unsuitable, another session writing it, a failed copy or a failed sync). */
	skipped: { worktree: string; reason: string }[];
}

export interface SessionSeedInput {
	cwd: string;
	exists(path: string): boolean;
	sourceBusy?(commonRoot: string): boolean;
	copy(from: string, to: string): boolean;
	/** The source checkout's recorded index version, or undefined when it has no marker. */
	readSourceIndexVersion?(commonRoot: string): string | undefined;
	/** Records the version the copied index carries; absent callers get no marker written. */
	writeIndexVersion?(version: string): void;
	/** The source checkout's recorded index version, or undefined when it has no marker. */
	readSourceIndexVersion?(commonRoot: string): string | undefined;
	/** Records the version the copied index carries; absent callers get no marker written. */
	writeIndexVersion?(version: string): void;
	/**
	 * Runs `codegraph <args>` in `cwd`; true when it exited 0. This is the sync that follows the copy, so a seeded
	 * worktree answers with its own tree. Absent means the seed stays copy-only (the unit tests, and any caller
	 * that runs seeding without a CLI). `onSpawn` gets the pid of the spawned process, as `runCodegraph` does.
	 */
	run?(args: string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, options?: { proxy?: boolean }) => void): Promise<boolean>;
	/**
	 * The package's index lock, so the seed copy plus its sync never overlaps another session's init or sync on
	 * the same worktree. Absent means no coordination (the unit tests, and any caller that seeds without a lock);
	 * the failure cleanup below does not depend on it.
	 */
	lock?: InitLock;
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
 * main repo has none, is left alone. A seeded worktree is a file copy plus one sync in that tree, exactly as at
 * a session start: only when the sync succeeded does it count as seeded, because the copied db still holds the
 * main checkout's data. The copy and its sync run under the package's index lock, so they never overlap another
 * session's init or sync on the same worktree, and a failed sync removes the copied index instead of leaving
 * stale main-checkout data behind. Callers run it in the background and never wait for it.
 */
export async function seedSessionWorktrees(input: SessionSeedInput): Promise<SessionSeedResult> {
	try {
		const mainIndex = join(input.cwd, ".codegraph", "codegraph.db");
		if (!input.exists(mainIndex) || input.sourceBusy?.(input.cwd) === true) return { seeded: [], skipped: [{ worktree: input.cwd, reason: "the session's own index is missing or being written" }] };
		const result: SessionSeedResult = { seeded: [], skipped: [] };
		for (const root of siblingWorktrees(input.cwd)) {
			try {
				const wt = worktreeOf(root);
				if (!wt.worktree) continue;
				if (input.exists(join(root, ".codegraph"))) { result.skipped.push({ worktree: root, reason: "already has an index" }); continue; }
				// One index writer per worktree at a time: the copy plus its sync hold the package's lock, exactly as
				// an init or reindex does, so this never overlaps another session's work on the same tree.
				const attempt = input.lock?.acquire(root);
				if (attempt?.status === "busy") { result.skipped.push({ worktree: root, reason: "another session is writing this worktree's index" }); continue; }
				const adopt = attempt?.status === "acquired" ? attempt.adopt : () => {};
				try {
					// Another session may have completed an init between the outer check and this lock: overwriting its
					// index and then deleting it on a failed sync would destroy a finished index.
					if (input.exists(join(root, ".codegraph"))) { result.skipped.push({ worktree: root, reason: "already has an index" }); continue; }
					// The copy reads the source checkout's db: hold the source's own index lock across the copy, so a
					// concurrent init or sync of the main checkout cannot start while its database is being read. The
					// follow-up sync runs after this release: it writes the worktree, not the source.
					const source = input.lock?.acquire(wt.commonRoot, { kind: "sync" });
					if (source?.status === "busy") { result.skipped.push({ worktree: root, reason: "the main checkout's index is being written" }); continue; }
					let copied = false;
					let sourceVersion: string | undefined;
					try {
						// This seed now holds the package lock on the source, so the package's own busy state must not
						// block its copy (it would see its own lock and skip every worktree). The remaining hazard is an
						// external writer such as CodeGraph's own process: only its writer lock counts inside our lock.
						// The source's recorded version is captured under that same lock: it describes the db being copied.
						copied = seedWorktreeIndex({ worktree: root, commonRoot: wt.commonRoot, sourceBusy: (root0) => codegraphWritingIndex(root0), copy: input.copy });
						// The source's recorded version is captured under this same lock: it describes the db being copied.
						sourceVersion = input.readSourceIndexVersion?.(wt.commonRoot);
					} finally {
						source?.release();
					}
					if (!copied) { result.skipped.push({ worktree: root, reason: "the seed copy failed" }); continue; }
					// The copy alone still carries the main checkout's data, so the worktree counts as seeded only after
					// the sync that reconciles it to this tree. Without a run callback nothing syncs (copy-only).
					if (input.run !== undefined) {
						let synced = false;
						try {
							synced = await input.run(["sync", "-q"], root, SYNC_TIMEOUT_MS, (pid, options) => {
								try { adopt(pid, options); } catch { /* recording the pid is never worth failing the sync */ }
							});
						} catch {
							synced = false;
						}
						if (!synced) {
							// The copied db is still the main checkout's: leaving it behind would make every later child
							// read stale data and skip preparation. Removing it restores a worktree that initializes fresh.
							try { rmSync(join(root, ".codegraph"), { recursive: true, force: true }); } catch { /* a leftover index is still the next session's problem, never a throw */ }
							result.skipped.push({ worktree: root, reason: "the seed sync failed" });
							continue;
						}
					}
					result.seeded.push(join(root, ".codegraph", "codegraph.db"));
					// The copied index keeps the source's recorded version: writing the running engine's version here
					// would mask a needed rebuild. A source without a marker leaves the copy unmarked instead.
					if (sourceVersion !== undefined) input.writeIndexVersion?.(sourceVersion);

					// The copied index keeps the source's recorded version: writing the running engine's version would
					// mask a needed rebuild. A source without a marker leaves the copy unmarked instead.
					if (sourceVersion !== undefined) input.writeIndexVersion?.(sourceVersion);
				} finally {
					attempt?.release();
				}
			} catch (error) {
				result.skipped.push({ worktree: root, reason: `unexpected: ${(error as Error).message}` });
			}
		}
		return result;
	} catch {
		return { seeded: [], skipped: [] };
	}
}
