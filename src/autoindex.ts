import { spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { mayInitiateIndexWrite, type IndexRole } from "./agents.ts";
import { codegraphWritingIndex, type InitLock } from "./initlock.ts";
import { killTree } from "./prefetch.ts";
import { projectArgument } from "./daemonclient.ts";
import { codegraphSpawn } from "./paths.ts";
import { seedWorktreeIndex, worktreeIndexAction, worktreeOf } from "./seed.ts";

export { codegraphWritingIndex } from "./initlock.ts";

/** One of these next to a `.git` is what makes a directory a project worth indexing automatically. */
export const INIT_PROJECT_MARKERS = ["composer.json", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts"];

export const SYNC_TIMEOUT_MS = 120_000;
export const INIT_TIMEOUT_MS = 600_000;

/** The environment variable a subagent child carries; children never start an index operation of their own. */
export const CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";

export type IndexAction = "sync" | "init" | "seed" | "none";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** What one coordinated sync did here, or why it did not run. */
export type SyncRunOutcome =
	/** The sync ran in this session. */
	| { status: "ran"; ok: boolean }
	/** Another session's run, which started after this request, completed: the demand was served. */
	| { status: "coalesced" }
	/** The index was locked (an init runs, or a process of this package still writes it) or this session waited too
	 * long: nothing ran for the request yet, and it is still recorded on disk for the next sync. */
	| { status: "queued" }
	/** The coordination state could not be used, so no sync was started: failing closed beats two syncs at once. */
	| { status: "unavailable" };

/** Called with the process the sync started, so the coordination can tell a run that ended from one that went on. */
export type SyncSpawn = (pid: number, options?: { proxy?: boolean }) => void;

/**
 * What one coordinated sync request achieved, in terms that never overstate it: `synced` only for a run that
 * came back successfully, `coalesced` only for another session's run that started after this request and
 * completed, `pending` for a request that is recorded but has not run, `unavailable` for state that could not be
 * used at all, and `failed` for a run that came back with an error.
 */
export type CoordinatedSyncOutcome = "synced" | "coalesced" | "pending" | "failed" | "unavailable";

/** The honest reading of one coordination result. */
export function coordinatedSyncOutcome(outcome: SyncRunOutcome): CoordinatedSyncOutcome {
	if (outcome.status === "ran") return outcome.ok ? "synced" : "failed";
	if (outcome.status === "coalesced") return "coalesced";
	if (outcome.status === "queued") return "pending";
	return "unavailable";
}

/** The honest reading of one attempt made under the index lock alone, with no lease to wait on. */
export function attemptOutcome(attempt: SyncAttemptResult): CoordinatedSyncOutcome {
	if (!attempt.ran) return "pending";
	return attempt.ok ? "synced" : "failed";
}

export interface SyncRequestInput {
	/** The project whose index is synced. */
	project: string;
	/** The per-project sync coordination shared with the other sessions of this user. */
	sync: SyncCoordinator;
	/** The package's index lock: a sync and an init of one project never run at the same time. */
	lock?: InitLock;
	run(args: string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, options?: { proxy?: boolean }) => void): Promise<boolean>;
}

/**
 * Asks the coordination for one sync of `project` and reports what it achieved. The run itself happens through
 * {@link runSyncAttempt}, so it holds the package's index lock: nothing here can start an uncoordinated write.
 * Never throws on its own; a failing command comes back as `failed`.
 */
export async function requestCoordinatedSync(input: SyncRequestInput): Promise<CoordinatedSyncOutcome> {
	const outcome = await input.sync.request(input.project, (onSpawn) =>
		runSyncAttempt({ cwd: input.project, lock: input.lock, run: input.run }, onSpawn));
	return coordinatedSyncOutcome(outcome);
}

/** One attempt under the coordination: it ran the command, or the index was locked and nothing ran. */
export type SyncAttemptResult = { ran: true; ok: boolean } | { ran: false };

/**
 * Keeps one extension-started sync per project at a time across the sessions of this user, and turns a request
 * that arrives during another sync into a single follow-up of it. Absent in a unit test: no coordination.
 */
export interface SyncCoordinator {
	request(project: string, attempt: (onSpawn: SyncSpawn) => Promise<SyncAttemptResult>): Promise<SyncRunOutcome>;
}

/** An existing index is synced; a fresh git project with a marker file is initialised; anything else is left alone. */
export function planIndexAction(cwd: string, exists: (path: string) => boolean): IndexAction {
	if (exists(join(cwd, ".codegraph"))) return "sync";
	if (exists(join(cwd, ".git")) && INIT_PROJECT_MARKERS.some((marker) => exists(join(cwd, marker)))) return "init";
	return "none";
}
export interface AutoIndexInput {
	/** Where Pi was started. */
	cwd: string;
	env: Record<string, string | undefined>;
	reason: SessionStartReason;
	exists(path: string): boolean;
	/** One init per project across sessions; absent means no coordination (the unit tests). */
	lock?: InitLock;
	/** One sync per project at a time across sessions, with pending requests coalesced; absent means no coordination. */
	sync?: SyncCoordinator;
	/** Whether the main repo's index is being written right now, for seeding a worktree from it. Defaults to the init lock of the common root. */
	sourceBusy?(commonRoot: string): boolean;
	/** Copies the seed db from the main repo into the worktree; defaults to a plain file copy. */
	copySeed?(from: string, to: string): boolean;
	/** Called right before the command starts, so the user can be told what is going on. */
	onStart?(action: "sync" | "init" | "seed"): void;
	/** Whether CodeGraph is writing this index right now; defaults to {@link codegraphWritingIndex}. */
	codegraphBusy?(cwd: string): boolean;
	/** Runs `codegraph <args>` in `cwd`; true when it exited 0. `onSpawn` gets the pid of that process. */
	run(args: string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, options?: { proxy?: boolean }) => void): Promise<boolean>;
}

/** Subagent children of one parent share the parent's project: a /reload is not a new session. */
function skipsSession(input: Pick<AutoIndexInput, "cwd" | "env" | "reason" | "exists">): boolean {
	return input.env[CHILD_ENV] === "1" && !childWorktreeNeedsIndex(input) || input.reason === "reload";
}

/**
 * A subagent child may run in a linked git worktree of its own instead of the parent's project (the
 * orchestrator hands out `workspace_root`). There it does the same background work a fresh session would:
 * seed its own index from the main checkout's, or initialise one. Everywhere else a child keeps skipping:
 * it shares the parent's cwd, and the parent already did the work — a child never starts an index for the
 * parent's own project.
 */
function childWorktreeNeedsIndex(input: Pick<AutoIndexInput, "cwd" | "env" | "exists">): boolean {
	if (input.env[CHILD_ENV] !== "1") return false;
	if (!worktreeOf(input.cwd).worktree) return false;
	if (input.exists(join(input.cwd, ".codegraph"))) return false;
	const action = worktreeIndexAction(input.cwd, input.exists).action;
	return action === "seed" || action === "init";
}

export interface AutoIndexResult {
	action: IndexAction;
	ok: boolean;
	/** Another session was already creating the index, so this one left it alone. */
	joined?: boolean;
	/** Another session was already syncing, so this one left the sync to it; its run completed. */
	coalesced?: boolean;
	/** The request is recorded on disk and still waiting for the index to be free; nothing ran yet. */
	queued?: boolean;
	/** The coordination state could not be used, so no sync was started here. */
	unavailable?: boolean;
}

/** Brings the CodeGraph index of the project Pi started in up to date, or creates it. Never rejects. */
export async function autoIndex(input: AutoIndexInput): Promise<AutoIndexResult> {
	try {
		if (skipsSession(input)) return { action: "none", ok: true };
		const worktreeAction = worktreeIndexAction(input.cwd, input.exists);
		const action: IndexAction = worktreeAction.action === "none" ? "none" : worktreeAction.action;
		if (action === "none") return { action, ok: true };
		const announce = () => { try { input.onStart?.(action); } catch { /* telling the user is never worth stopping the index */ } };
		if (action === "seed") {
			// Two sessions starting at once in the same worktree must not seed twice: the worktree's own init
			// lock covers the whole seed-plus-sync, exactly like a plain init.
			const attempt = input.lock?.acquire(input.cwd);
			if (attempt?.status === "busy") return { action, ok: true, joined: true };
			const adopt = attempt?.status === "acquired" ? attempt.adopt : () => {};
			try {
				if (input.exists(join(input.cwd, ".codegraph"))) return { action, ok: true, joined: true };
				const commonRoot = (worktreeAction as { action: "seed"; commonRoot: string }).commonRoot;
				const busy = input.sourceBusy ?? ((root: string) => input.lock?.isHeld(root) ?? false);
				if (busy(commonRoot)) return { action, ok: true, joined: true };
				announce();
				const seeded = seedWorktreeIndex({
					worktree: input.cwd,
					commonRoot,
					sourceBusy: () => busy(commonRoot),
					copy: input.copySeed ?? defaultCopySeed,
				});
				if (!seeded) return { action, ok: false };
				// The seeded db reflects the main tree; the worktree's first sync reconciles it to this tree.
				const ok = await input.run(["sync", "-q"], input.cwd, SYNC_TIMEOUT_MS, (pid, options) => adopt(pid, options));
				return { action, ok };
			} finally {
				attempt?.release();
			}
		}
		if (action === "sync") {
			// An init holds the index: nothing may touch it meanwhile, and this session leaves it to that one.
			// A sync holding it is different: the index exists, so this request is coalesced into it instead.
			if (input.lock?.isHeld(input.cwd) && (input.lock.isInitRunning?.(input.cwd) ?? true)) return { action, ok: true, joined: true };
			announce();
			// Every write goes through the coordination: the shared lease when there is one, and always through
			// the package's index lock, so an init cannot begin in the middle of this sync (nor this one inside an
			// init). Without a coordination (a unit test) the lock alone decides, and a locked index leaves the
			// request pending instead of syncing beside another writer.
			const outcome = input.sync === undefined
				? attemptOutcome(await runSyncAttempt(input, () => {}))
				: await requestCoordinatedSync({ project: input.cwd, sync: input.sync, lock: input.lock, run: input.run });
			if (outcome === "synced") return { action, ok: true };
			if (outcome === "coalesced") return { action, ok: true, coalesced: true };
			if (outcome === "pending") return { action, ok: true, queued: true };
			if (outcome === "unavailable") return { action, ok: false, unavailable: true };
			return { action, ok: false };
		}
		const attempt = input.lock?.acquire(input.cwd);
		if (attempt?.status === "busy") return { action, ok: true, joined: true };
		const adopt = attempt?.status === "acquired" ? attempt.adopt : () => {};
		try {
			if (input.exists(join(input.cwd, ".codegraph"))) {
				// Another party (another tool, a terminal) created the index while this session waited for the lock.
				return { action, ok: true, joined: true };
			}
			announce();
			// The lock records the pid of the init, so it stays held while that process lives, even after this session.
			const initialised = await input.run(["init", "-y"], input.cwd, INIT_TIMEOUT_MS, (pid, options) => adopt(pid, options));
			if (!initialised && (input.codegraphBusy ?? codegraphWritingIndex)(input.cwd)) {
				// CodeGraph's own lock still names a live init: another party is building this index, not this session.
				return { action, ok: true, joined: true };
			}
			// A failure of this session's own init, with or without a half-built index, is a failure.
			return { action, ok: initialised };
		} finally {
			attempt?.release();
		}
	} catch {
		return { action: planIndexAction(input.cwd, input.exists), ok: false };
	}
}

export interface LinkedWorktreeSeedInput {
	/** The linked worktrees of one repository, as `git worktree list --porcelain` reports them. */
	worktrees: readonly string[];
	/** One init per project across sessions; absent means no coordination (the unit tests). */
	lock?: InitLock;
	exists(path: string): boolean;
	/** Whether the main checkout's index of this worktree is being written right now. */
	sourceBusy(commonRoot: string): boolean;
	/** Copies the seed db from the main checkout into the worktree. */
	copy(from: string, to: string): boolean;
}

export interface LinkedWorktreeSeedResult {
	/** The worktrees whose own index was seeded, one db path each. */
	seeded: string[];
	/** Every worktree that was left alone, with why (already indexed, not a worktree, busy, or a failed copy). */
	skipped: { worktree: string; reason: string }[];
}

/**
 * Seeds the unindexed linked worktrees of one repository, each one under its own index lock, exactly like the
 * per-directory seed of {@link autoIndex}: a worktree whose index another session is writing is left alone, a
 * fresh decision is taken once the lock is held, and a failed copy leaves nothing behind. The main checkout is
 * never seeded (it is not a worktree). Never throws.
 */
export function seedLinkedWorktrees(input: LinkedWorktreeSeedInput): LinkedWorktreeSeedResult {
	const result: LinkedWorktreeSeedResult = { seeded: [], skipped: [] };
	for (const root of input.worktrees) {
		try {
			const found = worktreeOf(root);
			if (!found.worktree) continue; // the main checkout and anything not linked is not our business here
			if (input.exists(join(root, ".codegraph"))) { result.skipped.push({ worktree: root, reason: "already has an index" }); continue; }
			const attempt = input.lock?.acquire(root, { kind: "init" });
			if (attempt?.status === "busy") { result.skipped.push({ worktree: root, reason: "another session is writing this worktree's index" }); continue; }
			try {
				// Judged again under the lock: another session may have seeded it while this one waited.
				if (input.exists(join(root, ".codegraph"))) { result.skipped.push({ worktree: root, reason: "already has an index" }); continue; }
				if (input.sourceBusy(found.commonRoot)) { result.skipped.push({ worktree: root, reason: "the main checkout's index is being written" }); continue; }
				const seeded = seedWorktreeIndex({
					worktree: root,
					commonRoot: found.commonRoot,
					sourceBusy: () => input.sourceBusy(found.commonRoot),
					copy: input.copy,
				});
				if (seeded) result.seeded.push(join(root, ".codegraph", "codegraph.db"));
				else result.skipped.push({ worktree: root, reason: "the seed copy failed" });
			} finally {
				attempt?.release();
			}
		} catch (error) {
			result.skipped.push({ worktree: root, reason: `unexpected: ${(error as Error).message}` });
		}
	}
	return result;
}

/**
 * How long the tool result of a native `codegraph init` waits for the sync the plugin requested before it reports
 * it as pending. The request is not cancelled: it stays recorded in the coordination and runs when the index is
 * free, so the 10 s only bounds how long the tool call waits for its answer.
 */
export const POST_INIT_SYNC_WAIT_MS = 10_000;

/** What the post-`init` hook could report. Only `completed` means a sync really came back. */
export type PostInitSyncOutcome = "completed" | "pending" | "failed" | "unavailable" | "skipped-read-only";

export interface PostInitSyncInput {
	/** The checkout the observed init ran in: its own index, never a parent checkout's. */
	cwd: string;
	exists(path: string): boolean;
	/** The package's index lock: the sync holds it for its whole run. */
	lock?: InitLock;
	/** The per-project sync coordination shared with the other sessions of this user. */
	sync: SyncCoordinator;
	run(args: string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, options?: { proxy?: boolean }) => void): Promise<boolean>;
	/** The role of this session, when it is a subagent child: a read-only role starts no index write. */
	role?: IndexRole;
	/** Overrides {@link POST_INIT_SYNC_WAIT_MS}. */
	waitMs?: number;
	/** Where the final outcome goes: the request may finish after the tool result was already returned. */
	log?(entry: { cwd: string; outcome: string; ms: number }): void;
}

/**
 * After a native `codegraph init` came back successfully, requests exactly one coordinated sync of that checkout
 * through the package's own coordination, never a second uncoordinated `init` or `sync`. It returns `completed`
 * only for a run that really came back, `pending` for a request that is still recorded on disk, and `failed` or
 * `unavailable` otherwise; the final outcome is logged even when the bounded wait already returned `pending`.
 * Never throws.
 */
export async function syncAfterNativeInit(input: PostInitSyncInput): Promise<PostInitSyncOutcome> {
	const started = Date.now();
	try {
		if (!mayInitiateIndexWrite(input.role)) return "skipped-read-only";
		if (!input.exists(join(input.cwd, ".codegraph"))) {
			// A successful init that left no index gives nothing to sync, and syncing a missing index would fail.
			input.log?.({ cwd: input.cwd, outcome: "init-sync-failed", ms: Date.now() - started });
			return "failed";
		}
		const request = requestCoordinatedSync({ project: input.cwd, sync: input.sync, lock: input.lock, run: input.run });
		// The request keeps going after the wait below; its real outcome is what gets logged, once.
		const settled = request.then(
			(value) => {
				input.log?.({ cwd: input.cwd, outcome: `init-sync-${value}`, ms: Date.now() - started });
				return value;
			},
			() => {
				input.log?.({ cwd: input.cwd, outcome: "init-sync-failed", ms: Date.now() - started });
				return "failed" as const;
			},
		);
		const waitMs = Math.max(1, input.waitMs ?? POST_INIT_SYNC_WAIT_MS);
		const raced = await Promise.race([
			settled,
			new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), waitMs); }),
		]);
		if (raced === undefined) return "pending";
		if (raced === "synced" || raced === "coalesced") return "completed";
		if (raced === "pending") return "pending";
		if (raced === "unavailable") return "unavailable";
		return "failed";
	} catch {
		return "failed";
	}
}

/** The seed copy for real runs: a plain file copy of the db, staged by {@link seedWorktreeIndex}. */
function defaultCopySeed(from: string, to: string): boolean {
	try {
		copyFileSync(from, to);
		return true;
	} catch {
		return false;
	}
}

/** What one coordinated sync attempt needs: the project, the package's index lock and the way to run the CLI. */
export type SyncAttemptInput = Pick<AutoIndexInput, "cwd" | "lock" | "run">;

/**
 * One sync attempt under the coordination. It takes the package's index lock for the whole run, so an init can
 * never begin in the middle of a sync: the lock is taken, not merely observed, which is what closes the window
 * between deciding to sync and starting it. When an init (or any other writer of this package) holds the lock,
 * nothing runs and the coordination keeps the request pending instead of dropping it. The process it starts is
 * reported to `onSpawn`, so the coordination can tell a run that ended from one that outlived its session.
 */
export async function runSyncAttempt(input: SyncAttemptInput, onSpawn: SyncSpawn): Promise<SyncAttemptResult> {
	const attempt = input.lock?.acquire(input.cwd, { kind: "sync" });
	if (attempt?.status === "busy") return { ran: false };
	const adopt = attempt?.status === "acquired" ? attempt.adopt : () => {};
	try {
		const ok = await input.run(["sync", "-q"], input.cwd, SYNC_TIMEOUT_MS, (pid, options) => {
			try { adopt(pid, options); } catch { /* recording the pid is never worth failing the sync */ }
			try { onSpawn(pid, options); } catch { /* the coordination record is never worth failing the sync */ }
		});
		return { ran: true, ok };
	} finally {
		attempt?.release();
	}
}

/** How long a killed init may take to be gone before the timeout is reported anyway. */
const KILL_WAIT_MS = 10_000;

/**
 * Runs the codegraph CLI with fixed arguments for the project in `cwd`. It runs from
 * the temp dir with the project as the last argument (`sync -q <path>`, `init -y <path>`), spelled as its
 * daemon registered it; cmd.exe does not accept a UNC working directory, and another spelling starts another daemon.
 * `onSpawn` gets the pid of the process, which the init lock records, and whether that pid is only the shell
 * that was spawned around the real init (Windows runs the npm shim through a shell). A timeout kills the
 * process tree and only reports the failure once that process is gone: its pid must not outlive the result.
 */
export function runCodegraph(args: string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, options?: { proxy?: boolean }) => void): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let grace: ReturnType<typeof setTimeout> | undefined;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			resolve(ok);
		};
		let child;
		// Windows needs a shell to run the .cmd shim that npm installs for codegraph: the pid that comes back is
		// that shell, not the process that ends up writing the index.
		const shelled = process.platform === "win32";
		try {
			const run = codegraphSpawn(args, projectArgument(cwd));
			const env = { ...process.env, ...run.env };
			child = run.shell
				? spawn(run.command, { cwd: run.cwd, env, shell: true, windowsHide: true, stdio: "ignore" })
				: spawn(run.command, run.args, { cwd: run.cwd, env, windowsHide: true, stdio: "ignore" });
		} catch {
			resolve(false);
			return;
		}
		if (child.pid !== undefined) {
			try { onSpawn?.(child.pid, { proxy: shelled }); } catch { /* recording the pid is never worth failing the init */ }
		}
		timer = setTimeout(() => {
			killTree(child.pid, child);
			// A killed init may still be closing; the lock lookup waits for it, up to a point.
			grace = setTimeout(() => finish(false), KILL_WAIT_MS);
		}, timeoutMs);
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}

export interface PrepareInput extends AutoIndexInput {
	/** Called as soon as the sync or init is over, before the warm-up starts. */
	onIndexed?(result: AutoIndexResult): void;
	/** Called right before the daemon warm-up starts. */
	onWarmStart?(): void;
	/** Makes the project's daemon ready for its first real call; true when it worked. */
	warm(cwd: string): Promise<boolean>;
}

export interface PrepareResult {
	index: AutoIndexResult;
	warm: "ok" | "failed" | "skipped";
}

/** The index first (sync or init), then, when an index exists, the daemon warm-up. Never rejects. */
export async function prepareProject(input: PrepareInput): Promise<PrepareResult> {
	const index = await autoIndex(input);
	if (index.action !== "none") {
		try { input.onIndexed?.(index); } catch { /* telling the user is never worth stopping the warm-up */ }
	}
	// A sync that failed still leaves an index to warm; a failed init or seed leaves nothing worth warming.
	const hasIndex = !index.joined && (index.action === "sync" || (index.action === "init" && index.ok) || (index.action === "seed" && index.ok));
	if (skipsSession(input) || !hasIndex) return { index, warm: "skipped" };
	try { input.onWarmStart?.(); } catch { /* telling the user is never worth stopping the warm-up */ }
	try {
		return { index, warm: (await input.warm(input.cwd)) ? "ok" : "failed" };
	} catch {
		return { index, warm: "failed" };
	}
}
