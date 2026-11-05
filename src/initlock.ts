import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRoot } from "./daemonclient.ts";

/**
 * One `codegraph init` per project at a time, across every Pi session of this user on the machine (the temp folder
 * is per user, so sessions of another Windows account are not seen). CodeGraph's own `init`
 * can hang for good when two start at the same instant, or when anything opens the database in the first
 * moments after the index was created, so the sessions that lose the race leave the index alone.
 *
 * The lock is a directory in the temp folder (creating a directory is atomic) holding `owner.json`. Clearing a
 * stale lock happens under a second directory, `<lock>.takeover`, so only one session at a time can do it.
 * The pids in `owner.json` are not the whole truth: on Windows `codegraph` is started through a shell, and that
 * shell can die while the init itself goes on. CodeGraph's own `.codegraph/codegraph.lock` names the process that
 * really writes the index, so it is consulted as well.
 */

/** The longest an init is allowed to run (10 minutes) plus a minute: beyond that the lock is not trusted. */
export const LOCK_MAX_AGE_MS = 11 * 60_000;
/** An empty lock directory this young is an owner about to write its record; older ones were abandoned. */
const UNWRITTEN_GRACE_MS = 10_000;
/** Clearing a stale lock takes milliseconds: a takeover guard older than this was left by a session that died. */
const TAKEOVER_GRACE_MS = 10_000;
/**
 * How long a record whose adopted pid may be only the shell around the real init is trusted after that spawn.
 * The shell can die while the init goes on, and the init announces itself in CodeGraph's own lock only a
 * moment later (about half a second here); before that there is nothing to tell a starting init from a dead one.
 */
export const PROXY_TRUST_MS = 60_000;

export interface LockOptions {
	/** Where lock directories live; defaults to the temp folder. */
	dir?: string;
	isAlive?(pid: number): boolean;
	now?(): number;
	/** Tests only: called after a stale lock was found and before it is cleared. */
	onStale?(): void;
}

export type LockAttempt =
	| {
		status: "acquired";
		/**
		 * Records the init process too: the lock stays held while it lives, even after this session is gone.
		 * `proxy: true` when the pid is only the process that was spawned around the real init (Windows runs
		 * `codegraph` through a shell): that shell can die while the init goes on, so the record is trusted for
		 * {@link PROXY_TRUST_MS} after the spawn as well, until CodeGraph's own lock names the init.
		 */
		adopt(pid: number, options?: { proxy?: boolean }): void;
		release(): void;
	}
	| { status: "busy" };

/** What `autoIndex` needs from a lock; the real one is {@link realInitLock}. */
export interface InitLock {
	acquire(project: string): LockAttempt;
	isHeld(project: string): boolean;
}

interface Owner {
	pid: number;
	startedAt: number;
	/** Tells this session's lock apart from a later one taken by a session with the same pid. */
	token: string;
	/** The init process this session started, which can outlive the session. */
	initPid?: number;
	/** When `initPid` was adopted, for the window in which a proxy pid is trusted on its own. */
	initPidAt?: number;
	/** `initPid` is the process that was spawned around the init (a shell), not the init itself. */
	initProxy?: boolean;
}

function lockPath(project: string, options: LockOptions): string {
	const key = createHash("sha256").update(normalizeRoot(project)).digest("hex").slice(0, 16);
	return join(options.dir ?? tmpdir(), `pcs-init-${key}`);
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as { code?: string }).code === "EPERM";
	}
}

/** CodeGraph writes the pid of whatever writes the index here and removes the file when it ends, on failure too. */
const CODEGRAPH_LOCK = join(".codegraph", "codegraph.lock");

/**
 * Whether a CodeGraph process is writing the index of `project` right now, whoever started it (another Pi, the
 * project daemon, a git hook, a terminal). CodeGraph holds `.codegraph/codegraph.lock` for every operation that
 * writes the index (`init`, `sync`, a file index) and removes it when it ends; reads and queries never hold it.
 * A pid that is not alive left the file behind. Any other error is a false: this never throws.
 */
export function codegraphWritingIndex(project: string): boolean {
	try {
		const pid = Number.parseInt(readFileSync(join(project, CODEGRAPH_LOCK), "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 && processExists(pid);
	} catch {
		return false;
	}
}

function readOwner(lock: string): Owner | undefined {
	try {
		const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
		const valid = Number.isInteger(owner.pid) && typeof owner.startedAt === "number" && typeof owner.token === "string"
			&& (owner.initPid === undefined || Number.isInteger(owner.initPid))
			&& (owner.initPidAt === undefined || typeof owner.initPidAt === "number")
			&& (owner.initProxy === undefined || typeof owner.initProxy === "boolean");
		return valid ? owner : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the lock at `lock` still belongs to someone who is working. A missing lock is not held. */
function held(project: string, lock: string, options: LockOptions): boolean {
	const now = options.now?.() ?? Date.now();
	let directory;
	try { directory = statSync(lock); } catch { return false; }
	const owner = readOwner(lock);
	// No readable record: its owner is probably still writing it, unless it has been this way for a while.
	if (owner === undefined) return now - directory.mtimeMs < UNWRITTEN_GRACE_MS;
	if (now - owner.startedAt > LOCK_MAX_AGE_MS) return false;
	const isAlive = options.isAlive ?? processExists;
	if (isAlive(owner.pid)) return true;
	if (owner.initPid !== undefined && isAlive(owner.initPid)) return true;
	// The process writing the index itself, whatever pid this session spawned or adopted: on Windows the
	// adopted pid is the shell, and a shell dies with the session that started it while the init goes on.
	// That pid is another process, so it is judged with the real process table, not with a test hook.
	if (codegraphWritingIndex(project)) return true;
	// Right after the spawn CodeGraph has not written its lock yet; until then the record speaks for the init.
	return owner.initProxy === true && owner.initPidAt !== undefined && now - owner.initPidAt < PROXY_TRUST_MS;
}

/** Replaces the owner record in one step, so a reader sees the old record or the new one, never none. */
function writeOwner(lock: string, owner: Owner): void {
	const draft = join(lock, `owner.${owner.token}.tmp`);
	writeFileSync(draft, JSON.stringify(owner));
	renameSync(draft, join(lock, "owner.json"));
}

/**
 * Clears the stale lock at `lock`; true when the caller may try to take it again. Only the session holding the
 * takeover guard gets this far, and it checks again under the guard: another session may have taken the lock
 * over since this one judged it stale.
 */
function clearStale(project: string, lock: string, options: LockOptions, token: string): boolean {
	const guard = `${lock}.takeover`;
	try {
		mkdirSync(guard);
	} catch {
		// Someone else is taking it over right now, or died doing it: then the next session gets its turn.
		try {
			if ((options.now?.() ?? Date.now()) - statSync(guard).mtimeMs > TAKEOVER_GRACE_MS) rmSync(guard, { recursive: true, force: true });
		} catch { /* already gone */ }
		return false;
	}
	try {
		if (held(project, lock, options)) return false;
		const judged = readOwner(lock)?.token;
		const aside = `${lock}.stale-${token}`;
		try { renameSync(lock, aside); } catch { return true; /* its owner removed it meanwhile */ }
		if (readOwner(aside)?.token !== judged) {
			// Not the lock judged stale: its owner left and another session took it in between. Give it back.
			try { renameSync(aside, lock); } catch { /* the lock is taken again; the moved one is lost either way */ }
			return false;
		}
		try { rmSync(aside, { recursive: true, force: true }); } catch { /* leftovers are harmless */ }
		return true;
	} finally {
		try { rmSync(guard, { recursive: true, force: true }); } catch { /* a guard left behind expires */ }
	}
}

/**
 * Takes the init lock of `project`. Never throws: when the temp folder cannot be used the session goes on as if
 * it had the lock, which is how it behaved before locks existed.
 */
export function tryAcquireInitLock(project: string, options: LockOptions = {}): LockAttempt {
	const lock = lockPath(project, options);
	const mine: Owner = { pid: process.pid, startedAt: options.now?.() ?? Date.now(), token: randomBytes(8).toString("hex") };
	const adopt = (pid: number, adoptOptions: { proxy?: boolean } = {}) => {
		if (readOwner(lock)?.token !== mine.token) return;
		mine.initPid = pid;
		mine.initPidAt = options.now?.() ?? Date.now();
		mine.initProxy = adoptOptions.proxy === true;
		try { writeOwner(lock, mine); } catch { /* the lock still holds while this session lives */ }
	};
	const release = () => {
		// Only remove what is still ours: after a takeover the lock belongs to someone else.
		const owner = readOwner(lock);
		if (owner && owner.token === mine.token) rmSync(lock, { recursive: true, force: true });
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(lock);
			writeOwner(lock, mine);
			return { status: "acquired", adopt, release };
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") return { status: "acquired", adopt: () => {}, release: () => {} };
		}
		if (held(project, lock, options)) return { status: "busy" };
		options.onStale?.();
		if (!clearStale(project, lock, options, mine.token)) return { status: "busy" };
	}
	return { status: "busy" };
}

/**
 * Whether the init lock of `project` is held right now: a session is running an init, or CodeGraph itself is still
 * writing the index it started. Reads only.
 */
export function isInitLocked(project: string, options: LockOptions = {}): boolean {
	try {
		return held(project, lockPath(project, options), options);
	} catch {
		return false;
	}
}

export const realInitLock: InitLock = {
	acquire: (project) => tryAcquireInitLock(project),
	isHeld: (project) => isInitLocked(project),
};
