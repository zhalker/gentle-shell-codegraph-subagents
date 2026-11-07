import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNC_TIMEOUT_MS, type SyncAttemptResult, type SyncRunOutcome, type SyncSpawn } from "../src/autoindex.ts";
import { compactionSync, compactionSyncLock, type CompactionSyncOutcome } from "../src/compaction-sync.ts";
import { isInitLocked, isInitRunning, tryAcquireInitLock } from "../src/initlock.ts";

// A compaction leaves the index stale while the session goes on: one background sync, never an init, never a
// notification, and never a second sync of the same project at the same time as another session's.

const CWD = join("some", "repo");
const has = (...present: string[]) => (path: string) => present.some((name) => path.endsWith(name));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
};

/** A project and a temp folder of their own, so the tests never meet the user's locks. */
function scratch(): { dir: string; project: string } {
	return {
		dir: realpathSync(mkdtempSync(join(tmpdir(), "pcs-sync-state-"))),
		project: realpathSync(mkdtempSync(join(tmpdir(), "pcs-sync-project-"))),
	};
}

interface LogEntry {
	cwd: string;
	outcome: CompactionSyncOutcome;
	ms: number;
}

function captured() {
	const entries: LogEntry[] = [];
	return { entries, log: (entry: LogEntry) => { entries.push(entry); } };
}

/** The real index lock over one temp folder, as the extension wires it. */
function indexLock(dir: string) {
	return {
		acquire: (project: string, options?: { kind?: "init" | "sync" }) => tryAcquireInitLock(project, { dir }, options?.kind),
		isHeld: (project: string) => isInitLocked(project, { dir }),
		isInitRunning: (project: string) => isInitRunning(project, { dir }),
	};
}

/** A coordinator that does no coordination: the attempt runs here, now. */
const direct = {
	request: async (_project: string, attempt: (onSpawn: SyncSpawn) => Promise<SyncAttemptResult>): Promise<SyncRunOutcome> => {
		const result = await attempt(() => {});
		return result.ran ? { status: "ran", ok: result.ok } : { status: "queued" };
	},
};
const coalescing = { request: async (): Promise<SyncRunOutcome> => ({ status: "coalesced" }) };
const queuedElsewhere = { request: async (): Promise<SyncRunOutcome> => ({ status: "queued" }) };
const unavailable = { request: async (): Promise<SyncRunOutcome> => ({ status: "unavailable" }) };

test("S1: a compaction of a session with an index runs one quiet sync, never an init", async () => {
	const calls: { args: string[]; cwd: string; timeoutMs: number }[] = [];
	const { entries, log } = captured();
	const result = await compactionSync({
		cwd: CWD,
		env: {},
		exists: has(".codegraph"),
		sync: direct,
		log,
		run: async (args, cwd, timeoutMs) => { calls.push({ args, cwd, timeoutMs }); return true; },
	});
	assert.deepEqual(calls, [{ args: ["sync", "-q"], cwd: CWD, timeoutMs: SYNC_TIMEOUT_MS }]);
	assert.deepEqual(result, { outcome: "synced" });
	assert.equal(entries.length, 1);
	assert.deepEqual({ cwd: entries[0].cwd, outcome: entries[0].outcome }, { cwd: CWD, outcome: "synced" });
	assert.ok(entries[0].ms >= 0);
});

test("S1: a git project without an index is left alone: a compaction never initialises it", async () => {
	for (const present of [[".git", "package.json"], [".git"], []]) {
		const calls: string[][] = [];
		const { entries, log } = captured();
		const result = await compactionSync({
			cwd: CWD, env: {}, exists: has(...present), sync: direct, log,
			run: async (args) => { calls.push(args); return true; },
		});
		assert.deepEqual(calls, [], JSON.stringify(present));
		assert.deepEqual(result, { outcome: "skipped-no-index" }, JSON.stringify(present));
		assert.equal(entries[0].outcome, "skipped-no-index");
	}
});

test("S4: a subagent child never starts a compaction sync, even with an index", async () => {
	const calls: string[][] = [];
	const { entries, log } = captured();
	let coordinated = false;
	const result = await compactionSync({
		cwd: CWD, env: { GENTLE_PI_AGENTS_CHILD: "1" }, exists: has(".codegraph"), log,
		sync: { request: async (project, attempt) => { coordinated = true; return direct.request(project, attempt); } },
		run: async (args) => { calls.push(args); return true; },
	});
	assert.deepEqual(result, { outcome: "skipped-child" });
	assert.deepEqual(calls, []);
	assert.equal(coordinated, false, "a child does not even look at the coordination");
	assert.equal(entries[0].outcome, "skipped-child");
});

test("A5: a compaction during an init is not dropped: it waits for the init, then syncs under the lock", async () => {
	const { dir, project } = scratch();
	const lock = indexLock(dir);
	const init = tryAcquireInitLock(project, { dir }, "init");
	assert.equal(init.status, "acquired");
	const runs: string[] = [];
	const { entries, log } = captured();
	const request = compactionSync({
		cwd: project, env: {}, exists: has(".codegraph"), lock, log,
		sync: compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 30_000 }),
		run: async () => {
			// The sync holds the package's index lock while it runs: no init can begin in the middle of it.
			assert.equal(isInitLocked(project, { dir }), true, "the sync runs holding the index lock");
			assert.equal(isInitRunning(project, { dir }), false, "a sync holder is not an init: the explorer may still prefetch");
			runs.push("ran");
			return true;
		},
	});
	await pause(200);
	assert.deepEqual(runs, [], "the index is being initialised: nothing may sync meanwhile");
	if (init.status === "acquired") init.release();
	const result = await request;
	assert.deepEqual(result, { outcome: "synced" });
	assert.deepEqual(runs, ["ran"]);
	assert.equal(entries[0].outcome, "synced");
});

test("A5: a compaction that cannot get the index before it gives up says so and leaves the demand on disk", async () => {
	const { dir, project } = scratch();
	const lock = indexLock(dir);
	const init = tryAcquireInitLock(project, { dir }, "init");
	assert.equal(init.status, "acquired");
	const runs: string[] = [];
	const { entries, log } = captured();
	const result = await compactionSync({
		cwd: project, env: {}, exists: has(".codegraph"), lock, log,
		sync: compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 200 }),
		run: async () => { runs.push("ran"); return true; },
	});
	assert.deepEqual(runs, [], "the init still owns the index");
	assert.deepEqual(result, { outcome: "queued" }, "not coalesced: nothing ran for it yet");
	assert.equal(entries[0].outcome, "queued");
	if (init.status === "acquired") init.release();
	// A later sync of the same project serves the request the session left behind.
	const later: string[] = [];
	const served = await compactionSync({
		cwd: project, env: {}, exists: has(".codegraph"), lock,
		sync: compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 30_000 }),
		run: async () => { later.push("ran"); return true; },
		log: () => {},
	});
	assert.deepEqual(served, { outcome: "synced" });
	assert.deepEqual(later, ["ran"], "the pending request was served, not lost");
});

test("S3: a failing compaction sync is logged as failed and never thrown, and nothing else is told", async () => {
	for (const failure of ["exit", "throw"] as const) {
		const { entries, log } = captured();
		const result = await compactionSync({
			cwd: CWD, env: {}, exists: has(".codegraph"), log, sync: direct,
			run: async () => { if (failure === "throw") throw new Error("boom"); return false; },
		});
		assert.deepEqual(result, { outcome: "failed" }, failure);
		// The only thing a failure produces is the diagnostic line: no message, no notice, no result to show.
		assert.deepEqual(Object.keys(result), ["outcome"], failure);
		assert.deepEqual(entries.map((entry) => entry.outcome), ["failed"], failure);
	}
});

test("S2: when another session is already syncing, the compaction leaves the run to it", async () => {
	const calls: string[][] = [];
	const { entries, log } = captured();
	const result = await compactionSync({
		cwd: CWD, env: {}, exists: has(".codegraph"), sync: coalescing, log,
		run: async (args) => { calls.push(args); return true; },
	});
	assert.deepEqual(calls, []);
	assert.deepEqual(result, { outcome: "coalesced" });
	assert.equal(entries[0].outcome, "coalesced");
});

test("S2: a compaction whose request is still waiting is logged as queued, never as coalesced", async () => {
	for (const [sync, expected] of [[queuedElsewhere, "queued"], [unavailable, "skipped-coordination-unavailable"]] as const) {
		const calls: string[][] = [];
		const { entries, log } = captured();
		const result = await compactionSync({
			cwd: CWD, env: {}, exists: has(".codegraph"), sync, log,
			run: async (args) => { calls.push(args); return true; },
		});
		assert.deepEqual(calls, [], expected);
		assert.deepEqual(result, { outcome: expected });
		assert.equal(entries[0].outcome, expected);
	}
});

test("S2: the compaction sync reaches the coordinator with the project and the quiet command", async () => {
	const projects: string[] = [];
	const { log } = captured();
	await compactionSync({
		cwd: CWD, env: {}, exists: has(".codegraph"), log,
		sync: {
			request: async (project, attempt) => {
				projects.push(project);
				assert.deepEqual(await attempt(() => {}), { ran: true, ok: true });
				return { status: "ran", ok: true };
			},
		},
		run: async (args, cwd) => args[0] === "sync" && cwd === CWD,
	});
	assert.deepEqual(projects, [CWD]);
});

test("S2: unusable coordination state starts no sync at all (fail closed), and says so", async () => {
	const file = join(scratch().dir, "not-a-directory");
	writeFileSync(file, "");
	let ran = false;
	const { entries, log } = captured();
	const result = await compactionSync({
		cwd: CWD, env: {}, exists: has(".codegraph"), log,
		sync: compactionSyncLock({ dir: file, pollMs: 5, requestWaitMs: 500 }),
		run: async () => { ran = true; return true; },
	});
	assert.equal(ran, false, "without its coordination state the package does not risk a second sync");
	assert.deepEqual(result, { outcome: "skipped-coordination-unavailable" });
	assert.equal(entries[0].outcome, "skipped-coordination-unavailable");
});

// --- The coordinator: one extension-started sync per project at a time, pending demand coalesced. ---

/** A run that fails the test if two of them overlap, and records when each one started. */
function guardedRun(runs: { start: number }[], state: { running: boolean }, holdMs: number) {
	return async () => {
		assert.equal(state.running, false, "two syncs of one project ran at the same time");
		state.running = true;
		runs.push({ start: Date.now() });
		try {
			await pause(holdMs);
		} finally {
			state.running = false;
		}
		return { ran: true as const, ok: true };
	};
}

test("S2: a request during a running sync becomes exactly one follow-up, never a simultaneous run", async () => {
	const { dir, project } = scratch();
	const coordinator = compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 20_000 });
	const runs: { start: number }[] = [];
	const state = { running: false };
	const run = guardedRun(runs, state, 300);
	const first = coordinator.request(project, run);
	await pause(50);
	const requestedAt = [Date.now()];
	const second = coordinator.request(project, run);
	await pause(10);
	requestedAt.push(Date.now());
	const third = coordinator.request(project, run);
	const [a, b, c] = await Promise.all([first, second, third]);
	assert.deepEqual(a, { status: "ran", ok: true });
	assert.deepEqual(b, { status: "coalesced" });
	assert.deepEqual(c, { status: "coalesced" });
	assert.equal(runs.length, 2, "one run plus one follow-up for both requests together");
	// Neither request was dropped: each is covered by a run that started after it was made.
	for (const at of requestedAt) assert.ok(runs.some((entry) => entry.start >= at), `request at ${at} is covered: ${JSON.stringify(runs)}`);
});

test("S2: a request that arrives during the follow-up is served by a further one, so no demand is lost", async () => {
	const { dir, project } = scratch();
	const coordinator = compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 20_000 });
	const runs: { start: number }[] = [];
	const state = { running: false };
	const run = guardedRun(runs, state, 250);
	const first = coordinator.request(project, run);
	await pause(50);
	const second = coordinator.request(project, run);
	// The follow-up starts when the first run ends; ask again inside it.
	await pause(250);
	const thirdAt = Date.now();
	const third = coordinator.request(project, run);
	const [a, b, c] = await Promise.all([first, second, third]);
	assert.deepEqual(a, { status: "ran", ok: true });
	assert.deepEqual(b, { status: "coalesced" });
	assert.deepEqual(c, { status: "coalesced" });
	assert.equal(runs.length, 3, `each request gets a run after it: ${JSON.stringify(runs)}`);
	assert.ok(runs.some((entry) => entry.start >= thirdAt));
});

test("S2: a run that fails still lets the next request through", async () => {
	const { dir, project } = scratch();
	const coordinator = compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 20_000 });
	const failed = await coordinator.request(project, async () => ({ ran: true, ok: false }));
	assert.deepEqual(failed, { status: "ran", ok: false });
	const again = await coordinator.request(project, async () => ({ ran: true, ok: true }));
	assert.deepEqual(again, { status: "ran", ok: true }, "the lease of a failed run is released");
});

test("S2: a run that cannot get the index leaves the demand pending and says queued", async () => {
	const { dir, project } = scratch();
	const coordinator = compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 200 });
	const outcome = await coordinator.request(project, async () => ({ ran: false }));
	assert.deepEqual(outcome, { status: "queued" }, "no run happened: coalesced would be a lie");
});

test("S2: different projects sync independently", async () => {
	const { dir, project } = scratch();
	const other = scratch().project;
	const coordinator = compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 20_000 });
	const [a, b] = await Promise.all([
		coordinator.request(project, guardedRun([], { running: false }, 200)),
		coordinator.request(other, guardedRun([], { running: false }, 200)),
	]);
	assert.deepEqual([a.status, b.status], ["ran", "ran"]);
});

test("S2: the same project spelled with a trailing separator shares one sync lease", async () => {
	const { dir, project } = scratch();
	const other = process.platform === "win32" ? project.toUpperCase() : `${project}/`;
	const coordinator = compactionSyncLock({ dir, pollMs: 5, requestWaitMs: 20_000 });
	const runs: { start: number }[] = [];
	const state = { running: false };
	const first = coordinator.request(project, guardedRun(runs, state, 300));
	await pause(50);
	const second = coordinator.request(other, guardedRun(runs, state, 50));
	const [a, b] = await Promise.all([first, second]);
	assert.deepEqual(a, { status: "ran", ok: true });
	assert.deepEqual(b, { status: "coalesced" }, "another spelling of one folder is the same project");
});

// --- Across processes: cooperative sessions of this user sharing the same temp folder. ---

interface WorkerResult {
	status?: string;
	pid: number;
	cliPid?: number;
	requestedAt: number;
	returnedAt: number;
	outcome: SyncRunOutcome;
}

const workerPath = () => join(import.meta.dirname, "lock-worker.ts");
const ledgerPath = (project: string) => join(project, "runs.log");
const ledgerText = (project: string): string => {
	try { return readFileSync(ledgerPath(project), "utf8"); } catch { return ""; }
};
const starts = (text: string) => text.split("\n").filter((line) => line.startsWith("start ")).length;
const lineTime = (text: string, prefix: string): number | undefined => {
	const line = text.split("\n").find((entry) => entry.startsWith(`${prefix} `));
	return line === undefined ? undefined : Number(line.split(" ")[1]);
};

/** One worker session; `firstLine` resolves with the first JSON line it prints, `result` when it ends. */
function runWorker(dir: string, project: string, holdMs: number, mode = "sync", startAt = 0) {
	const child = spawn(process.execPath, [workerPath(), dir, project, String(startAt), String(holdMs), mode], { stdio: ["ignore", "pipe", "ignore"] });
	let out = "";
	let announced = false;
	let announce: (result: WorkerResult) => void = () => {};
	const firstLine = new Promise<WorkerResult>((resolve) => { announce = resolve; });
	const read = () => {
		if (announced || !out.includes("\n")) return;
		announced = true;
		try { announce(JSON.parse(out.trim().split("\n")[0])); } catch { announce({ pid: 0, requestedAt: 0, returnedAt: 0, outcome: { status: "unavailable" } }); }
	};
	child.stdout.on("data", (chunk) => { out += chunk; read(); });
	const result = new Promise<WorkerResult>((resolve) => {
		child.on("close", () => {
			read();
			try { resolve(JSON.parse(out.trim().split("\n")[0])); } catch { resolve({ pid: 0, requestedAt: 0, returnedAt: 0, outcome: { status: "unavailable" } }); }
		});
	});
	return { child, firstLine, result };
}

async function waitFor(check: () => boolean, what: string, deadlineMs = 60_000): Promise<void> {
	const until = Date.now() + deadlineMs;
	while (Date.now() < until) {
		if (check()) return;
		await pause(25);
	}
	assert.fail(`timed out waiting for ${what}`);
}

/** The runs the workers recorded: their start and end, in the order they happened. */
function recordedRuns(project: string): { start: number; end: number }[] {
	const intervals: { start: number; end: number }[] = [];
	for (const line of ledgerText(project).split("\n").filter(Boolean)) {
		const [kind, at] = line.split(" ");
		if (kind === "start") intervals.push({ start: Number(at), end: Number.POSITIVE_INFINITY });
		else if (kind === "end" && intervals.length > 0) intervals[intervals.length - 1].end = Number(at);
	}
	// A run whose end was never written was killed; it says nothing about overlaps of the runs that finished.
	return intervals.filter((interval) => Number.isFinite(interval.end));
}

test("S2 real: sessions asking at the same instant: one runs, the others leave their demand to it, never two at once", { timeout: 120_000 }, async () => {
	for (const sessions of [2, 3]) {
		const { dir, project } = scratch();
		const startAt = Date.now() + 2_000;
		const results = await Promise.all(Array.from({ length: sessions }, () => runWorker(dir, project, 600, "sync", startAt).result));
		const runners = results.filter((result) => result.outcome.status === "ran");
		const waiters = results.filter((result) => result.outcome.status !== "ran");
		assert.equal(runners.length, 1, `${sessions} sessions, one runner: ${JSON.stringify(results)}`);
		assert.equal(waiters.length, sessions - 1, JSON.stringify(results));
		assert.ok(waiters.every((result) => result.outcome.status === "coalesced"), JSON.stringify(results));
		const runs = recordedRuns(project);
		// The demand of a session that asked before the run started is served by that run; one that asks during it
		// makes one follow-up. Either way, never more than one follow-up and never two at once.
		assert.ok(runs.length >= 1 && runs.length <= 2, `${sessions} sessions, at most one follow-up: ${JSON.stringify(runs)}`);
		for (let index = 1; index < runs.length; index++) {
			assert.ok(runs[index].start >= runs[index - 1].end, `no two syncs overlapped: ${JSON.stringify(runs)}`);
		}
		for (const waiter of waiters) {
			assert.ok(runs.some((entry) => entry.start >= waiter.requestedAt), `the demand of ${waiter.pid} was not lost: ${JSON.stringify(waiter)} ${JSON.stringify(runs)}`);
		}
		const leases = readdirSync(dir)
			.filter((entry) => entry.startsWith("pcs-sync-"))
			.filter((entry) => existsSync(join(dir, entry, "run")));
		assert.deepEqual(leases, [], `leftover leases in ${dir}`);
	}
});

test("S2 real: a session that asks while another one is syncing is coalesced into exactly one follow-up", { timeout: 120_000 }, async () => {
	const { dir, project } = scratch();
	const running = runWorker(dir, project, 1500);
	// Ask only once the other session is inside its run, so the request cannot be served by that run itself.
	await waitFor(() => starts(ledgerText(project)) >= 1, "the first run to start");
	const requestedAt = Date.now();
	const late = runWorker(dir, project, 100);
	const [first, second] = await Promise.all([running.result, late.result]);
	assert.deepEqual(first.outcome, { status: "ran", ok: true });
	assert.deepEqual(second.outcome, { status: "coalesced" });
	const runs = recordedRuns(project);
	assert.equal(runs.length, 2, `one run plus exactly one follow-up: ${JSON.stringify(runs)}`);
	assert.ok(runs[1].start >= runs[0].end, `the follow-up started after the run it was coalesced into: ${JSON.stringify(runs)}`);
	assert.ok(runs[1].start >= requestedAt, "the follow-up serves the request that arrived during the first run");
	assert.ok(second.requestedAt <= runs[1].start);
});

test("B1 real: a request is not lost when the runner dies inside its follow-up, and is answered only by a completed run", { timeout: 120_000 }, async () => {
	const { dir, project } = scratch();
	// A holds the lease and runs alone for 1,2 s.
	const a = runWorker(dir, project, 1200);
	await waitFor(() => starts(ledgerText(project)) >= 1, "A's run to start");
	// B asks while A runs: its demand has to be served by A's follow-up.
	const b = runWorker(dir, project, 200);
	await waitFor(() => starts(ledgerText(project)) >= 2, "A's follow-up to start");
	a.child.kill("SIGKILL");
	await a.result;
	const bResult = await b.result;
	// The follow-up never completed, so B was not told its demand was served: it takes the lease over and runs.
	assert.deepEqual(bResult.outcome, { status: "ran", ok: true }, `B served its own demand: ${JSON.stringify(bResult)}`);
	const runs = recordedRuns(project);
	assert.equal(runs.length, 2, `A's completed run and B's: ${JSON.stringify(runs)}`);
	assert.ok(runs[1].start >= runs[0].end, "B's run started only after A's completed run");
	const answered = runs.filter((run) => run.start >= bResult.requestedAt && run.end <= bResult.returnedAt);
	assert.ok(answered.length >= 1, `B was answered by a run that started after it asked and had finished: ${JSON.stringify(runs)} ${JSON.stringify(bResult)}`);
});

test("A1 real: the CLI a killed session started is still an extension sync: the next session waits for it, then syncs", { timeout: 120_000 }, async () => {
	const { dir, project } = scratch();
	const cliLifeMs = 4000;
	const a = runWorker(dir, project, cliLifeMs, "sync-cli");
	const started = await a.firstLine;
	assert.equal(started.status, "running");
	assert.ok((started.cliPid ?? 0) > 0, JSON.stringify(started));
	await waitFor(() => ledgerText(project).includes("cli-start"), "the CLI to start writing the index");
	a.child.kill("SIGKILL");
	await a.result;
	assert.equal(alive(started.cliPid!), true, "the CLI outlived the session that started it, as a real one can");
	// A second session asks for a sync while the abandoned CLI is still writing.
	const b = runWorker(dir, project, 100);
	const bResult = await b.result;
	assert.deepEqual(bResult.outcome, { status: "ran", ok: true });
	const text = ledgerText(project);
	await waitFor(() => text.includes("cli-end") || ledgerText(project).includes("cli-end"), "the CLI to finish");
	const cliEnd = lineTime(ledgerText(project), "cli-end");
	const cliStart = lineTime(ledgerText(project), "cli-start");
	assert.ok(cliEnd !== undefined && cliStart !== undefined);
	assert.ok(bResult.requestedAt < cliEnd!, "the second session asked while the abandoned CLI was still running");
	const runs = recordedRuns(project);
	assert.equal(runs.length, 1, `the abandoned CLI's run never completed; only the second session's did: ${JSON.stringify(runs)}`);
	assert.ok(runs[0].start >= cliEnd!, `the next sync started only after the abandoned CLI ended: ${JSON.stringify(runs)}`);
	assert.equal(alive(started.cliPid!), false, "nothing was killed to get there");
});

test("S3: the sync log keeps one line per request, sanitized like the prefetch log", async () => {
	const { logSync } = await import("../src/index-notice.ts");
	const dir = mkdtempSync(join(tmpdir(), "pcs-sync-log-"));
	logSync({ cwd: "/srv/a\tb\nc", outcome: "failed", ms: 12 }, dir);
	const lines = readFileSync(join(dir, "sync.log"), "utf8").split("\n").filter(Boolean);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\tfailed\t12ms\t\/srv\/a\?b\?c$/);
	assert.doesNotThrow(() => logSync({ cwd: CWD, outcome: "synced", ms: 1 }, join(dir, "nowhere", "at", "all")));
});
