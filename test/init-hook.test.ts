// S3: a native `codegraph init` is observed, never replaced. After a successful one this package requests exactly
// one sync through its own coordination and appends the outcome to the tool's result; a failed init keeps its
// original error and triggers nothing. Only a run that came back may be called completed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	POST_INIT_SYNC_WAIT_MS,
	syncAfterNativeInit,
	type SyncAttemptResult,
	type SyncCoordinator,
	type SyncRunOutcome,
	type SyncSpawn,
} from "../src/autoindex.ts";
import { initHookDecision, isNativeInitResult, postInitSyncNotice, type ToolResultSummary } from "../src/index-notice.ts";
import { indexRole, type IndexRole } from "../src/agents.ts";

function project(t: import("node:test").TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pcs-init-hook-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, ".codegraph"));
	return dir;
}

/** A coordinator that runs the attempt here and now, like a session that found the lease free. */
const runsHere = (runs: string[][], ok = true): SyncCoordinator => ({
	request: async (_project: string, attempt: (onSpawn: SyncSpawn) => Promise<SyncAttemptResult>): Promise<SyncRunOutcome> => {
		const result = await attempt(() => {});
		return result.ran ? { status: "ran", ok: result.ok } : { status: "queued" };
	},
});
const queuedElsewhere: SyncCoordinator = { request: async () => ({ status: "queued" }) };
const coalescing: SyncCoordinator = { request: async () => ({ status: "coalesced" }) };
const unavailable: SyncCoordinator = { request: async () => ({ status: "unavailable" }) };

const nativeInit = (over: Partial<ToolResultSummary> = {}): ToolResultSummary => ({ toolName: "codegraph", isError: false, input: { operation: "init" }, ...over });

test("S3: after a successful native init one coordinated sync runs and the result says completed", async (t) => {
	const cwd = project(t);
	const runs: string[][] = [];
	const seen: string[] = [];
	const outcome = await syncAfterNativeInit({
		cwd,
		exists: () => true,
		sync: runsHere(runs),
		run: async (args) => { runs.push(args); return true; },
		log: (entry) => seen.push(entry.outcome),
	});
	assert.equal(outcome, "completed");
	assert.deepEqual(runs, [["sync", "-q"]]);
	assert.deepEqual(seen, ["init-sync-synced"]);
});

test("S3: the outcome the hook waits for is bounded, and only a finished run is called completed", async (t) => {
	assert.equal(POST_INIT_SYNC_WAIT_MS, 10_000);
	const cwd = project(t);
	const started = Date.now();
	const outcome = await syncAfterNativeInit({
		cwd, exists: () => true, sync: queuedElsewhere, run: async () => true, waitMs: 20,
	});
	assert.equal(outcome, "pending");
	assert.ok(Date.now() - started < 2_000, "the tool result does not wait for a full sync");
});

test("S3: a sync another session's run completed after this request is completed, not a sync of this session", async (t) => {
	const cwd = project(t);
	let ran = false;
	const outcome = await syncAfterNativeInit({ cwd, exists: () => true, sync: coalescing, run: async () => { ran = true; return true; } });
	assert.equal(outcome, "completed");
	assert.equal(ran, false);
});

test("S3: a failed sync is reported as failed, and the command really ran once", async (t) => {
	const cwd = project(t);
	const runs: string[][] = [];
	const outcome = await syncAfterNativeInit({
		cwd, exists: () => true, sync: runsHere(runs), run: async (args) => { runs.push(args); return false; },
	});
	assert.equal(outcome, "failed");
	assert.equal(runs.length, 1);
});

test("S3: unusable coordination is reported as unavailable and nothing is run beside it", async (t) => {
	const cwd = project(t);
	let ran = false;
	const outcome = await syncAfterNativeInit({ cwd, exists: () => true, sync: unavailable, run: async () => { ran = true; return true; } });
	assert.equal(outcome, "unavailable");
	assert.equal(ran, false, "no uncoordinated sync may be started as a fallback");
});

test("S6: a read-only role starts no index write at all, and its tool result says why", async (t) => {
	const cwd = project(t);
	let asked = false;
	const outcome = await syncAfterNativeInit({
		cwd, exists: () => true, role: "read-only",
		sync: { request: async () => { asked = true; return { status: "coalesced" }; } },
		run: async () => { throw new Error("must not run"); },
	});
	assert.equal(outcome, "skipped-read-only");
	assert.equal(asked, false, "the coordination is not even asked");
	assert.match(postInitSyncNotice(outcome), /no sync was requested: this session's role is read-only/);
});

test("S3: an init that left no index requests nothing, because syncing a missing index would fail", async (t) => {
	const cwd = project(t);
	let asked = false;
	const outcome = await syncAfterNativeInit({
		cwd, exists: () => false,
		sync: { request: async () => { asked = true; return { status: "coalesced" }; } },
		run: async () => true,
	});
	assert.equal(outcome, "failed");
	assert.equal(asked, false);
});

test("S1: only a successful native `codegraph init` is observed; every other call is left alone", async () => {
	const role: IndexRole | undefined = undefined;
	assert.equal(isNativeInitResult(nativeInit()), true);
	assert.equal(initHookDecision(nativeInit(), role), "sync");

	// A failed init keeps its own error and triggers no sync.
	assert.equal(isNativeInitResult(nativeInit({ isError: true })), false);
	assert.equal(initHookDecision(nativeInit({ isError: true }), role), "skip-failed-init");

	// Another operation, the MCP tool, or an unrelated tool is not an init.
	assert.equal(initHookDecision(nativeInit({ input: { operation: "explore" } }), role), "skip-not-a-native-init");
	assert.equal(initHookDecision(nativeInit({ toolName: "mcp__codegraph__codegraph_explore", input: {} }), role), "skip-not-a-native-init");
	assert.equal(initHookDecision(nativeInit({ toolName: "bash", input: { command: "codegraph init" } }), role), "skip-not-a-native-init");
	// The plugin registers no tool of its own: the call it observes belongs to someone else.
	assert.equal(initHookDecision(nativeInit({ toolName: "codegraph" }), undefined), "sync");
});

test("S6: verify and the judges (a read-only role) get the read-only decision, other roles sync", async () => {
	const roles: [string, IndexRole][] = [
		["read,grep,find,bash,mcp__codegraph__codegraph_explore", "read-only"],
		["read,grep,find,mcp__codegraph__codegraph_explore", "explorer"],
		["read,grep,find,bash,edit,mcp__codegraph__codegraph_explore", "writer"],
	];
	for (const [list, expected] of roles) {
		assert.equal(indexRole(list.split(",")), expected, list);
	}
	assert.equal(initHookDecision(nativeInit(), "read-only"), "skip-read-only");
	assert.equal(initHookDecision(nativeInit(), "explorer"), "sync");
	assert.equal(initHookDecision(nativeInit(), "writer"), "sync");
	assert.equal(initHookDecision(nativeInit(), undefined), "sync", "the main session is not a read-only role");
});

test("S3/S6: the appended note never calls an unconfirmed index current", () => {
	assert.match(postInitSyncNotice("completed"), /one coordinated index sync completed/);
	assert.match(postInitSyncNotice("pending"), /pending/);
	assert.match(postInitSyncNotice("pending"), /not confirmed current/);
	assert.doesNotMatch(postInitSyncNotice("pending"), /synced|up to date/i);
	assert.match(postInitSyncNotice("failed"), /failed; this index may be behind/);
	assert.doesNotMatch(postInitSyncNotice("failed"), /synced/);
	assert.match(postInitSyncNotice("unavailable"), /no coordinated sync could be started/);
	assert.match(postInitSyncNotice("unavailable"), /not confirmed current/);
	assert.doesNotMatch(postInitSyncNotice("unavailable"), /synced/);
});
