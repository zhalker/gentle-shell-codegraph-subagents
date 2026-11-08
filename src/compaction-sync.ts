import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHILD_ENV,
	planIndexAction,
	runSyncAttempt,
	type SyncAttemptResult,
	type SyncCoordinator,
	type SyncRunOutcome,
	type SyncSpawn,
	SYNC_TIMEOUT_MS,
} from "./autoindex.ts";
import { normalizeRoot } from "./daemonclient.ts";
import { codegraphWritingIndex, PROXY_TRUST_MS, type InitLock } from "./initlock.ts";

/**
 * One extension-started `codegraph sync` per project at a time, across the Pi sessions of this user on the
 * machine (the temp folder is per user, so sessions of another account, another machine, a terminal or another
 * tool are not seen; see docs/known-limits.md). A request that arrives while a sync runs is recorded on disk and
 * served by a single follow-up run of the session that is syncing. No demand is dropped and two extension-started
 * syncs of one project never run at the same time.
 *
 * The state is a directory in the temp folder: `run/` is the lease of the session that syncs, `req/` holds one
 * file per request waiting for a follow-up, and `gate/` is the short mutex under which the lease is taken,
 * restamped, released and `req/` is read. A lease names the session and the process it started, and is taken over
 * (under the gate, never one that is still alive) only when both are gone: a `codegraph sync` that outlives the
 * session that started it is still an extension-started sync of this project.
 *
 * A request is only marked as served after the run that started after it has finished: the runner deletes the
 * requests it snapshotted *after* its command came back. A runner killed mid-run therefore leaves every pending
 * request in place for the next session, and a session is only ever told "coalesced" when a run really completed.
 */

/** One sync may run for its own 2-minute limit; a lease older than this cannot belong to a sync still running. */
export const SYNC_LEASE_MAX_AGE_MS = SYNC_TIMEOUT_MS + 60_000;
/** An empty lease directory this young is an owner about to write its record; older ones were abandoned. */
const UNWRITTEN_GRACE_MS = 10_000;
/** Taking the gate takes milliseconds: one older than this was left by a session that died inside it. */
const GATE_GRACE_MS = 10_000;
/** How long a session waits for the gate before it gives up: there is no safe way to coordinate without it. */
const GATE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 50;
/** How long a session whose sync waits for the running one looks for its request to be served. */
const DEFAULT_REQUEST_WAIT_MS = SYNC_LEASE_MAX_AGE_MS + 60_000;

export interface SyncOptions {
	/** Where the per-project sync state lives; defaults to the temp folder. */
	dir?: string;
	isAlive?(pid: number): boolean;
	/** Whether CodeGraph is writing this index right now; defaults to {@link codegraphWritingIndex}. */
	codegraphBusy?(project: string): boolean;
	now?(): number;
	/** How long a request waits for the index to be free and served; defaults to {@link DEFAULT_REQUEST_WAIT_MS}. */
	requestWaitMs?: number;
	pollMs?: number;
}

interface LeaseRecord {
	/** The session that took the lease. */
	pid: number;
	startedAt: number;
	/** Tells this session's lease apart from a later one taken by a session with the same pid. */
	token: string;
	/** The `codegraph sync` this session started; it can outlive the session. */
	cliPid?: number;
	cliPidAt?: number;
	/** `cliPid` is the shell spawned around the command (Windows runs the npm shim through a shell). */
	cliProxy?: boolean;
}

function stateDir(project: string, options: SyncOptions): string {
	const key = createHash("sha256").update(normalizeRoot(project)).digest("hex").slice(0, 16);
	return join(options.dir ?? tmpdir(), `pcs-sync-${key}`);
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

const leasePath = (state: string) => join(state, "run");
const requestsPath = (state: string) => join(state, "req");
const gatePath = (state: string) => join(state, "gate");

function readLease(state: string): LeaseRecord | undefined {
	try {
		const lease = JSON.parse(readFileSync(join(leasePath(state), "owner.json"), "utf8"));
		const valid = Number.isInteger(lease.pid) && typeof lease.startedAt === "number" && typeof lease.token === "string"
			&& (lease.cliPid === undefined || Number.isInteger(lease.cliPid))
			&& (lease.cliPidAt === undefined || typeof lease.cliPidAt === "number")
			&& (lease.cliProxy === undefined || typeof lease.cliProxy === "boolean");
		return valid ? lease : undefined;
	} catch {
		return undefined;
	}
}

/** Replaces the record in one step, so a reader sees the old record or the new one, never none. */
function writeLeaseRecord(state: string, lease: LeaseRecord): void {
	const draft = join(leasePath(state), `owner.${lease.token}.tmp`);
	writeFileSync(draft, JSON.stringify(lease));
	renameSync(draft, join(leasePath(state), "owner.json"));
}

function takeLease(state: string, lease: LeaseRecord): void {
	mkdirSync(leasePath(state));
	writeLeaseRecord(state, lease);
}

/** Whether the command this session started is still writing the index after the session itself is gone. */
function cliHeld(project: string, lease: LeaseRecord, now: number, options: SyncOptions): boolean {
	if (lease.cliPid === undefined || lease.cliPidAt === undefined) return false;
	// A sync of this package cannot last longer than its own timeout: an older record cannot name a live one.
	if (now - lease.cliPidAt > SYNC_LEASE_MAX_AGE_MS) return false;
	if ((options.isAlive ?? processExists)(lease.cliPid)) return true;
	if (lease.cliProxy !== true) return false;
	// On Windows the spawned shell can die while the command goes on. CodeGraph's own writer lock then names the
	// process that really writes the index; until that appears the record speaks for the command it just started.
	if ((options.codegraphBusy ?? codegraphWritingIndex)(project)) return true;
	return now - lease.cliPidAt < PROXY_TRUST_MS;
}

/** Whether the lease at `state` belongs to a sync of this project that is still going on. */
function leaseHeld(state: string, project: string, options: SyncOptions): boolean {
	const now = options.now?.() ?? Date.now();
	let directory;
	try { directory = statSync(leasePath(state)); } catch { return false; }
	const lease = readLease(state);
	// No readable record: its owner is probably still writing it, unless it has been this way for a while.
	if (lease === undefined) return now - directory.mtimeMs < UNWRITTEN_GRACE_MS;
	if (now - lease.startedAt <= SYNC_LEASE_MAX_AGE_MS && (options.isAlive ?? processExists)(lease.pid)) return true;
	return cliHeld(project, lease, now, options);
}

/**
 * Restamps this session's record before each run. A run is bounded by its own 2-minute timeout, so a session
 * that is alive and following up on requests never looks like one that is gone.
 */
function refreshLease(state: string, token: string, options: SyncOptions): void {
	const lease = readLease(state);
	if (lease === undefined || lease.token !== token) return;
	try {
		writeLeaseRecord(state, { pid: process.pid, startedAt: options.now?.() ?? Date.now(), token });
	} catch { /* the record it had is still there */ }
}

/** Records the command this session just started, so the lease keeps speaking for it after the session dies. */
function adoptCli(state: string, token: string, pid: number, spawn: { proxy?: boolean } | undefined, options: SyncOptions): void {
	const lease = readLease(state);
	if (lease === undefined || lease.token !== token) return;
	try {
		writeLeaseRecord(state, { ...lease, cliPid: pid, cliPidAt: options.now?.() ?? Date.now(), cliProxy: spawn?.proxy === true });
	} catch { /* the session itself still holds the lease; this only covers its death */ }
}

/** Forgets the command once the run it belonged to came back. */
function clearCli(state: string, token: string): void {
	const lease = readLease(state);
	if (lease === undefined || lease.token !== token) return;
	try {
		writeLeaseRecord(state, { pid: lease.pid, startedAt: lease.startedAt, token: lease.token });
	} catch { /* the record it had is still there */ }
}

/** Removes the lease only while it still carries `token`: after a takeover it belongs to someone else. */
function releaseLease(state: string, token: string): void {
	const lease = readLease(state);
	if (lease !== undefined && lease.token !== token) return;
	try { rmSync(leasePath(state), { recursive: true, force: true }); } catch { /* leftovers expire */ }
}

function pendingRequests(state: string): string[] {
	try {
		return readdirSync(requestsPath(state));
	} catch {
		return [];
	}
}

/** The gate could not be taken (or the state could not hold it), so nothing may be assumed about the coordination. */
const GATE_UNAVAILABLE = Symbol("gate-unavailable");

async function pause(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `action` holding the short per-project mutex that the lease and the pending requests share. */
async function withGate<T>(state: string, options: SyncOptions, action: () => T): Promise<T | typeof GATE_UNAVAILABLE> {
	const gate = gatePath(state);
	const deadline = Date.now() + GATE_TIMEOUT_MS;
	for (;;) {
		try {
			mkdirSync(gate);
			break;
		} catch (error) {
			// Anything but a gate another session holds means there is no usable state to coordinate through.
			if ((error as { code?: string }).code !== "EEXIST") return GATE_UNAVAILABLE;
		}
		try {
			if ((options.now?.() ?? Date.now()) - statSync(gate).mtimeMs > GATE_GRACE_MS) {
				rmSync(gate, { recursive: true, force: true });
				continue;
			}
		} catch { continue; /* it is gone already */ }
		if (Date.now() > deadline) return GATE_UNAVAILABLE;
		await pause(options.pollMs ?? DEFAULT_POLL_MS);
	}
	try {
		return action();
	} finally {
		try { rmSync(gate, { recursive: true, force: true }); } catch { /* a dead session's gate expires */ }
	}
}

/**
 * Takes the lease of `state` for this session: now, or after clearing one left by a sync that is really gone.
 * Nothing is cleared unless the gate was taken for real and the lease still looks dead under it, so a live lease
 * is never removed; `unavailable` means the state could not be used at all and no sync may start (fail closed).
 */
async function claimLease(state: string, project: string, token: string, options: SyncOptions): Promise<"acquired" | "busy" | "unavailable"> {
	for (;;) {
		try {
			takeLease(state, { pid: process.pid, startedAt: options.now?.() ?? Date.now(), token });
			return "acquired";
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") return "unavailable";
		}
		if (leaseHeld(state, project, options)) return "busy";
		const cleared = await withGate(state, options, () => {
			// Judged again under the gate: another session may have taken the lease since this one looked.
			if (leaseHeld(state, project, options)) return false;
			try { rmSync(leasePath(state), { recursive: true, force: true }); } catch { /* the owner removed it */ }
			return true;
		});
		if (cleared === GATE_UNAVAILABLE) return "unavailable";
		if (cleared === false) return "busy";
	}
}

/** What one pass as the runner did: a run, a locked index (an init runs), or state that cannot be used. */
type RunnerResult = { status: "ran"; ok: boolean } | { status: "busy" } | { status: "unavailable" };

class FileSyncCoordinator implements SyncCoordinator {
	private readonly options: SyncOptions;

	constructor(options: SyncOptions = {}) {
		this.options = options;
	}

	async request(project: string, attempt: (onSpawn: SyncSpawn) => Promise<SyncAttemptResult>): Promise<SyncRunOutcome> {
		const state = stateDir(project, this.options);
		const token = randomBytes(8).toString("hex");
		const marker = join(requestsPath(state), token);
		try {
			mkdirSync(requestsPath(state), { recursive: true });
			// The request is recorded before the lease is looked at, and stays there until a run that started after
			// it has finished. A session killed mid-sync loses nothing: its demand is still on disk for the next one.
			writeFileSync(marker, "");
		} catch {
			// Fail closed: without this state the package cannot tell whether another session is already syncing.
			return { status: "unavailable" };
		}
		const deadline = Date.now() + (this.options.requestWaitMs ?? DEFAULT_REQUEST_WAIT_MS);
		for (;;) {
			// A missing marker means the run that took it has finished: the demand was served, not merely picked up.
			if (!existsSync(marker)) return { status: "coalesced" };
			if (Date.now() >= deadline) return { status: "queued" };
			const claimed = await claimLease(state, project, token, this.options);
			if (claimed === "unavailable") return { status: "unavailable" };
			if (claimed === "acquired") {
				const result = await this.runAsRunner(state, project, token, attempt);
				if (result.status === "unavailable") return { status: "unavailable" };
				if (result.status === "ran") return { status: "ran", ok: result.ok };
				// The index is locked by an init: give the lease back and wait for it like every other request.
				await withGate(state, this.options, () => releaseLease(state, token));
			}
			await pause(this.options.pollMs ?? DEFAULT_POLL_MS);
		}
	}

	/**
	 * Runs the sync once for the requests already waiting, then once more per burst that arrived meanwhile: each
	 * burst becomes one follow-up. The requests of a run are deleted only after it came back, so a runner that dies
	 * inside it leaves every pending request for the next session, and the lease is only released under the gate
	 * once nothing is pending, so a request cannot fall between the last check and the release.
	 */
	private async runAsRunner(state: string, project: string, token: string, attempt: (onSpawn: SyncSpawn) => Promise<SyncAttemptResult>): Promise<RunnerResult> {
		try {
			for (;;) {
				const served = await withGate(state, this.options, () => {
					refreshLease(state, token, this.options);
					return pendingRequests(state);
				});
				if (served === GATE_UNAVAILABLE) return { status: "unavailable" };
				const result = await attempt((pid, options) => adoptCli(state, token, pid, options, this.options));
				if (!result.ran) return { status: "busy" };
				const more = await withGate(state, this.options, () => {
					clearCli(state, token);
					for (const request of served) {
						try { rmSync(join(requestsPath(state), request), { force: true }); } catch { /* gone already */ }
					}
					if (pendingRequests(state).length > 0) return true;
					releaseLease(state, token);
					return false;
				});
				if (more === GATE_UNAVAILABLE) {
					// The run happened, but its demand could not be marked as served: the next sync serves it again.
					return { status: "ran", ok: result.ok };
				}
				if (more !== true) return { status: "ran", ok: result.ok };
			}
		} finally {
			// A throwing sync still lets the next session in; a lease already released or taken over is left alone.
			releaseLease(state, token);
		}
	}
}

/** The real coordinator: one per process is enough, the state is on disk. */
export function compactionSyncLock(options: SyncOptions = {}): SyncCoordinator {
	return new FileSyncCoordinator(options);
}

export const realSyncLock: SyncCoordinator = compactionSyncLock();

export type CompactionSyncOutcome =
	| "synced"
	| "failed"
	/** Another session's run, which started after this request, completed. */
	| "coalesced"
	/** Nothing has run for it yet: the request waits on disk for the index to be free. */
	| "queued"
	| "skipped-no-index"
	| "skipped-child"
	/** The coordination state could not be used, so no sync was started here. */
	| "skipped-coordination-unavailable";

export interface CompactionSyncInput {
	/** Where Pi runs: the index of this directory is synced, never created. */
	cwd: string;
	env: Record<string, string | undefined>;
	exists(path: string): boolean;
	/** The package's index lock: a sync and an init of one project never run at the same time. */
	lock?: InitLock;
	sync: SyncCoordinator;
	run(args: string[], cwd: string, timeoutMs: number): Promise<boolean>;
	/** Where the diagnostic result goes: a compaction sync never notifies the session. */
	log(entry: { cwd: string; outcome: CompactionSyncOutcome; ms: number }): void;
}

/**
 * After a compaction the index is as stale as the session was long: request one background sync. It only ever
 * syncs an index that already exists, never initialises a project, never notifies the session and never throws;
 * its outcome goes to the log. A subagent child does nothing: it shares its parent's project. A request that finds
 * the index being initialised is kept and served once the init ends, not dropped.
 */
export async function compactionSync(input: CompactionSyncInput): Promise<{ outcome: CompactionSyncOutcome }> {
	const started = Date.now();
	let outcome: CompactionSyncOutcome;
	try {
		outcome = await decide(input);
	} catch {
		outcome = "failed";
	}
	try {
		input.log({ cwd: input.cwd, outcome, ms: Date.now() - started });
	} catch {
		// A log is never worth failing the session over.
	}
	return { outcome };
}

async function decide(input: CompactionSyncInput): Promise<CompactionSyncOutcome> {
	if (input.env[CHILD_ENV] === "1") return "skipped-child";
	if (planIndexAction(input.cwd, input.exists) !== "sync") return "skipped-no-index";
	const outcome = await input.sync.request(input.cwd, (onSpawn) => runSyncAttempt(input, onSpawn));
	if (outcome.status === "ran") return outcome.ok ? "synced" : "failed";
	if (outcome.status === "coalesced") return "coalesced";
	if (outcome.status === "queued") return "queued";
	return "skipped-coordination-unavailable";
}
