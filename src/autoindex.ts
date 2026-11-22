import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codegraphWritingIndex, isInitLocked, type InitLock } from "./initlock.ts";
import { killTree } from "./prefetch.ts";
import { projectArgument } from "./daemonclient.ts";
import { codegraphSpawn } from "./paths.ts";
import { seedWorktreeIndex, worktreeIndexAction, worktreeOf } from "./seed.ts";

export { codegraphWritingIndex } from "./initlock.ts";

/** The one of these next to a `.git` is what makes a directory a project worth indexing automatically. */
export const INIT_PROJECT_MARKERS = ["composer.json", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts"];

/** File inside `.codegraph/` recording which codegraph engine version left the index complete. */
export const INDEX_VERSION_MARKER = "indexer-version.json";

/** Where the index-version marker lives for this project. */
function markerPath(cwd: string): string {
	return join(cwd, ".codegraph", INDEX_VERSION_MARKER);
}

/** The engine version recorded for this project's index, or undefined when there is no record. */
export function readIndexVersionMarker(cwd: string, exists: (path: string) => boolean): string | undefined {
	const file = markerPath(cwd);
	if (!exists(file)) return undefined;
	try {
		const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
		return typeof version === "string" && version.length > 0 ? version : undefined;
	} catch {
		return undefined;
	}
}

/** Records that this project's index was (re)built by `version`, atomically: a reader sees the previous marker or the new one, never a truncated file. Never throws. */
export function writeIndexVersionMarker(cwd: string, version: string, _exists?: (path: string) => boolean): void {
	const file = markerPath(cwd);
	const staged = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(staged, JSON.stringify({ version }) + "\n");
		renameSync(staged, file);
	} catch {
		try { unlinkSync(staged); } catch { /* nothing to clean */ }
		/* an unwritable index directory loses nothing but the next reindex check */
	}
}

export type IndexVersionState = "current" | "reindex" | "unknown" | "none";

/**
 * Which engine version a freshly built or seeded index records. A rebuild and an init built this index with the
 * running engine; a seed copies the source checkout's index, so it keeps that source's recorded version — the
 * running version there would hide a still-needed rebuild in the copied index, and an unmarked source stays
 * unmarked rather than adopted as current.
 */
export function recordedSeedVersion(sourceVersion: string | undefined, engineVersion: string | undefined, action: IndexResultAction): string | undefined {
	if (engineVersion === undefined) return undefined;
	if (action === "reindex" || action === "init") return engineVersion;
	if (action === "seed") return sourceVersion;
	return undefined;
}

/**
 * Whether this project's index was built by the running engine version. `unknown` is an existing index
 * without a marker (built by a version of this package that did not record one): the caller reports it but
 * must not force a reindex of every project after this package's update — CodeGraph itself flags stale
 * indexes in its answers, so the user learns it either way.
 */
export function indexVersionMarker(cwd: string, engineVersion: string | undefined, exists: (path: string) => boolean, read?: () => string | undefined): IndexVersionState {
	if (!exists(join(cwd, ".codegraph"))) return "none";
	const recorded = read ? read() : readIndexVersionMarker(cwd, exists);
	if (recorded === undefined) return "unknown";
	return recorded === engineVersion ? "current" : "reindex";
}

/** How long `codegraph --version` may take before the engine version counts as unknown. */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * The version of the codegraph engine on Pi's PATH (`codegraph --version`), or undefined when it cannot be told.
 * Async so a caller can overlap it with other startup work; resolves undefined instead of rejecting.
 */
export function codegraphEngineVersion(): Promise<string | undefined> {
	return new Promise((resolve) => {
		let output = "";
		let child;
		try {
			// Windows needs a shell for the .cmd shim npm installs; one command line avoids passing args to a shell.
			child = process.platform === "win32"
				? spawn("codegraph --version", { cwd: tmpdir(), shell: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
				: spawn("codegraph", ["--version"], { cwd: tmpdir(), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			resolve(undefined);
			return;
		}
		const timer = setTimeout(() => { killTree(child.pid, child); resolve(undefined); }, VERSION_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
		child.on("error", () => { clearTimeout(timer); resolve(undefined); });
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? /\d+\.\d+\.\d+\S*/.exec(output)?.[0] : undefined);
		});
	});
}

export const SYNC_TIMEOUT_MS = 120_000;
export const INIT_TIMEOUT_MS = 600_000;

/** The environment variable a subagent child carries; it selects which of this package's index decisions a child skips or makes. */
export const CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";

export type IndexAction = "sync" | "init" | "seed" | "none";
/** What a session start did: a planned action, or a full rebuild of an index another engine version built. */
export type IndexResultAction = IndexAction | "reindex";
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
	onStart?(action: "sync" | "init" | "seed" | "reindex"): void;
	/** The running codegraph engine version; absent means no version check and no marker (the unit tests). */
	engineVersion?: string;
	/** The engine version recorded for this index; defaults to {@link readIndexVersionMarker}. */
	readIndexVersion?(): string | undefined;
	/** Records the engine version that (re)built this index; defaults to {@link writeIndexVersionMarker}. */
	writeIndexVersion?(version: string): void;
	/** Whether CodeGraph is writing this index right now; defaults to {@link codegraphWritingIndex}. */
	codegraphBusy?(cwd: string): boolean;
	/** Runs `codegraph <args>` in `cwd`; true when it exited 0. `onSpawn` gets the pid of that process. */
	run(args: string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, options?: { proxy?: boolean }) => void): Promise<boolean>;
}

/** Subagent children of one parent share the parent's project: a /reload is not a new session. */
function skipsSession(input: Pick<AutoIndexInput, "env" | "reason">): boolean {
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
	action: IndexResultAction;
	ok: boolean;
	/** Another session was already creating the index, so this one left it alone. */
	joined?: boolean;
	/** Another session was already syncing, so this one left the sync to it; its run completed. */
	coalesced?: boolean;
	/** For a seed: the engine version recorded in the source checkout's marker, when the seeded index kept it. */
	sourceVersion?: string;
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
				const busy = input.sourceBusy ?? ((root: string) => (typeof input.lock?.isInitLocked === "function" ? input.lock.isInitLocked(root) : false));
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
				// The copied index keeps the engine version that built it in the main checkout: recording the running
				// version here would hide a still-needed rebuild in the worktree. No source marker stays unknown.
				const sourceVersion = ok ? readIndexVersionMarker(commonRoot, input.exists) : undefined;
				return ok
					? { action, ok, ...(sourceVersion !== undefined ? { sourceVersion } : {}) }
					: { action, ok };
			} finally {
				attempt?.release();
			}
		}
		if (action === "sync" && input.engineVersion !== undefined
			&& indexVersionMarker(input.cwd, input.engineVersion, input.exists, input.readIndexVersion) === "reindex") {
			return await reindex(input);
		}
		if (action === "sync") {
			// An init holds the index: nothing may touch it meanwhile, and this session leaves it to that one.
			// A sync holding it is different: the index exists, so this request is coalesced into it instead.
			if (input.lock?.isHeld(input.cwd) && (input.lock.isInitRunning?.(input.cwd) ?? true)) return { action, ok: true, joined: true };
			announce();
			if (input.sync === undefined) return { action, ok: await input.run(["sync", "-q"], input.cwd, SYNC_TIMEOUT_MS) };
			const outcome = await input.sync.request(input.cwd, (onSpawn) => runSyncAttempt(input, onSpawn));
			if (outcome.status === "ran") return { action, ok: outcome.ok };
			if (outcome.status === "coalesced") return { action, ok: true, coalesced: true };
			if (outcome.status === "queued") return { action, ok: true, queued: true };
			return { action, ok: false, unavailable: true };
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
			return { action, ok: initialised };
		} finally {
			attempt?.release();
		}
	} catch {
		return { action: planIndexAction(input.cwd, input.exists), ok: false };
	}
}

/**
 * Rebuilds an index that another engine version built (`codegraph index`), coordinated exactly like an init: the
 * init lock covers the whole rebuild and records its process, and a busy lock means another writer is at work,
 * so this session joins instead of running.
 */
async function reindex(input: AutoIndexInput): Promise<AutoIndexResult> {
	const action = "reindex";
	const attempt = input.lock?.acquire(input.cwd);
	if (attempt?.status === "busy") return { action, ok: true, joined: true };
	const adopt = attempt?.status === "acquired" ? attempt.adopt : () => {};
	try {
		try { input.onStart?.(action); } catch { /* telling the user is never worth stopping the index */ }
		const ok = await input.run(["index", "-q"], input.cwd, INIT_TIMEOUT_MS, (pid, options) => adopt(pid, options));
		return { action, ok };
	} finally {
		attempt?.release();
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
	// Only an index this session built itself records a version: the helper returns the running engine for a
	// rebuild/init, the source checkout's recorded version for a seed (so a stale source still triggers the
	// worktree rebuild and an unmarked source stays unknown), and undefined for a sync.
	const built = index.action === "reindex" || index.action === "init" || index.action === "seed";
	const recorded = recordedSeedVersion(index.sourceVersion, input.engineVersion, index.action);
	if (recorded !== undefined && built && index.ok && !index.joined) {
		try {
			(input.writeIndexVersion ?? ((version: string) => writeIndexVersionMarker(input.cwd, version)))(recorded);
		} catch { /* a lost marker costs one more rebuild later, never the warm-up */ }
	}
	// A sync or a reindex that failed still leaves an index to warm; a failed init or seed leaves nothing worth warming.
	const hasIndex = !index.joined && (index.action === "sync" || index.action === "reindex" || (index.action === "init" && index.ok) || (index.action === "seed" && index.ok));
	if (skipsSession(input) || !hasIndex) return { index, warm: "skipped" };
	try { input.onWarmStart?.(); } catch { /* telling the user is never worth stopping the warm-up */ }
	try {
		return { index, warm: (await input.warm(input.cwd)) ? "ok" : "failed" };
	} catch {
		return { index, warm: "failed" };
	}
}
