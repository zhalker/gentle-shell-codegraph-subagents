// The explorer's prefetch, one case at a time: a live daemon answers with what it has, and with no usable
// daemon the CLI never runs; the warm-up starts in the background so the next explorer finds it warm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAEMON_PREFETCH_TIMEOUT_MS, explorePerCase, prefetchForExplorer } from "../src/prefetch.ts";

const MCP = "mcp__codegraph__codegraph_explore";
const CHILD = { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_REQUESTED_TOOLS: `read,grep,${MCP}` };
const PROJECT = "C:\\project";

interface Calls {
	daemon: number;
	warm: number;
	/** The limit the daemon was asked with. */
	timeoutMs: number;
}

interface DepsOptions {
	warmThrows?: boolean;
	warmRejects?: boolean;
	/** The warm-up never settles, as one waiting for a cold daemon on a network share does. */
	warmHangs?: boolean;
}

function deps(daemonResult: unknown, options: DepsOptions = {}) {
	const calls: Calls = { daemon: 0, warm: 0, timeoutMs: -1 };
	return {
		calls,
		deps: {
			daemon: async (_query: string, _cwd: string, timeoutMs: number) => {
				calls.daemon++;
				calls.timeoutMs = timeoutMs;
				return daemonResult;
			},
			warm: (_cwd: string) => {
				calls.warm++;
				if (options.warmHangs === true) return new Promise<unknown>(() => { /* never settles */ });
				if (options.warmThrows === true) throw new Error("spawn failed");
				if (options.warmRejects === true) return Promise.reject(new Error("warm failed"));
				return Promise.resolve(true);
			},
		},
	};
}

test("S15: the daemon is asked with a 10 s limit, not 8: a real prefetch answered in 8375 ms", async () => {
	assert.equal(DAEMON_PREFETCH_TIMEOUT_MS, 10_000);
	const { calls, deps: d } = deps({ status: "ok", text: "X" });
	await explorePerCase("q", PROJECT, d);
	assert.equal(calls.timeoutMs, 10_000);
});

test("S15: a daemon that answers hands over its text as ok, and nothing else runs", async () => {
	const { calls, deps: d } = deps({ status: "ok", text: "DAEMON TEXT\n" });
	assert.deepEqual(await explorePerCase("q", PROJECT, d), { text: "DAEMON TEXT\n", outcome: "ok" });
	assert.deepEqual([calls.warm, calls.timeoutMs], [0, 10_000]);
});

test("S15: a daemon that is too slow adds nothing and starts no warm-up; it is already running", async () => {
	const { calls, deps: d } = deps({ status: "timeout" });
	assert.deepEqual(await explorePerCase("q", PROJECT, d), { text: undefined, outcome: "daemon-timeout" });
	assert.equal(calls.warm, 0);
});

test("S15: with no daemon the prefetch returns at once and starts the warm-up once, without waiting for it", async () => {
	const { calls, deps: d } = deps({ status: "unavailable" }, { warmHangs: true });
	const started = Date.now();
	const result = await explorePerCase("q", PROJECT, d);
	assert.ok(Date.now() - started < 200, "must not wait for the warm-up");
	assert.deepEqual(result, { text: undefined, outcome: "skipped-no-daemon" });
	assert.equal(calls.warm, 1);
});

test("S15: a warm-up that throws or rejects never breaks the prefetch", async () => {
	for (const options of [{ warmThrows: true }, { warmRejects: true }]) {
		const { deps: d } = deps({ status: "unavailable" }, options);
		assert.deepEqual(await explorePerCase("q", PROJECT, d), { text: undefined, outcome: "skipped-no-daemon" }, JSON.stringify(options));
	}
});

test("S15: a rejected warm-up leaves no unhandled rejection behind", async () => {
	const seen: unknown[] = [];
	const record = (reason: unknown) => { seen.push(reason); };
	process.on("unhandledRejection", record);
	try {
		await explorePerCase("q", PROJECT, deps({ status: "unavailable" }, { warmRejects: true }).deps);
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.off("unhandledRejection", record);
	}
	assert.deepEqual(seen, []);
});

test("S15: a daemon client that throws is logged apart from a missing daemon and still warms once", async () => {
	const { calls, deps: d } = deps(undefined);
	d.daemon = async () => { calls.daemon++; throw new Error("boom"); };
	assert.deepEqual(await explorePerCase("q", PROJECT, d), { text: undefined, outcome: "daemon-error" });
	assert.equal(calls.warm, 1);
});

test("S15: a blank daemon answer is reported as empty, so nothing is handed to the explorer", async () => {
	const { calls, deps: d } = deps({ status: "ok", text: "  \n " });
	assert.deepEqual(await explorePerCase("q", PROJECT, d), { text: undefined, outcome: "empty" });
	assert.equal(calls.warm, 0);
});

test("S15: nothing is explored without an explorer child, a task, an index or a free init lock", async () => {
	const explored: string[] = [];
	const run = (label: string, input: object = {}) =>
		prefetchForExplorer({
			env: CHILD,
			prompt: "map how session discovery works",
			cwd: PROJECT,
			exists: () => true,
			explore: async () => { explored.push(label); return "TEXT"; },
			...input,
		});
	assert.equal(await run("main session", { env: {} }), undefined);
	assert.equal(await run("no task", { prompt: undefined }), undefined);
	assert.equal(await run("no index", { exists: () => false }), undefined);
	assert.equal(await run("init running", { initRunning: () => true }), undefined);
	assert.deepEqual(explored, []);
	const text = await run("explorer");
	assert.match(String(text), /CodeGraph pre-fetch/);
	assert.deepEqual(explored, ["explorer"]);
});
