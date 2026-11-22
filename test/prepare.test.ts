import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { prepareProject } from "../src/autoindex.ts";

const CWD = join("some", "repo");
const has = (...present: string[]) => (path: string) => present.some((name) => path.endsWith(name));

function setup(options: { present: string[]; run?: boolean; warm?: boolean | "throw"; env?: Record<string, string>; reason?: "startup" | "reload" | "new" | "resume" | "fork" }) {
	const log: string[] = [];
	const input = {
		cwd: CWD,
		env: options.env ?? {},
		reason: options.reason ?? ("startup" as const),
		exists: has(...options.present),
		onStart: (action: string) => log.push(`start:${action}`),
		run: async (args: string[]) => { log.push(`run:${args[0]}`); return options.run ?? true; },
		onIndexed: (result: { action: string; ok: boolean }) => log.push(`indexed:${result.action}:${result.ok}`),
		onWarmStart: () => log.push("warm-start"),
		warm: async (cwd: string) => {
			log.push(`warm:${cwd}`);
			if (options.warm === "throw") throw new Error("boom");
			return options.warm ?? true;
		},
	};
	return { log, input };
}

test("S14: with an index, the daemon is warmed after the sync, in that order", async () => {
	const { log, input } = setup({ present: [".codegraph"] });
	const result = await prepareProject(input);
	assert.deepEqual(log, ["start:sync", "run:sync", "indexed:sync:true", "warm-start", `warm:${CWD}`]);
	assert.deepEqual(result, { index: { action: "sync", ok: true }, warm: "ok" });
});

test("S14: a fresh init that worked is warmed too", async () => {
	const { log, input } = setup({ present: [".git", "package.json"] });
	const result = await prepareProject(input);
	assert.deepEqual(log, ["start:init", "run:init", "indexed:init:true", "warm-start", `warm:${CWD}`]);
	assert.equal(result.warm, "ok");
});

test("S14: an init that failed is not warmed", async () => {
	const { log, input } = setup({ present: [".git", "package.json"], run: false });
	const result = await prepareProject(input);
	assert.deepEqual(log, ["start:init", "run:init", "indexed:init:false"]);
	assert.deepEqual(result, { index: { action: "init", ok: false }, warm: "skipped" });
});

test("S16: the session that lost an init race neither syncs nor warms: touching the index while the other init runs can hang it", async () => {
	const log: string[] = [];
	let created = false;
	const result = await prepareProject({
		cwd: CWD, env: {}, reason: "startup",
		exists: (path) => path.endsWith(".git") || path.endsWith("package.json") || (created && path.endsWith(".codegraph")),
		// CodeGraph's own lock still names the live init of the other party.
		codegraphBusy: () => true,
		run: async (args) => { log.push(`run:${args[0]}`); if (args[0] === "init") created = true; return false; },
		onIndexed: (index) => log.push(`indexed:${index.action}:${index.ok}:${index.joined}`),
		onWarmStart: () => log.push("warm-start"),
		warm: async () => { log.push("warm"); return true; },
	});
	assert.deepEqual(log, ["run:init", "indexed:init:true:true"]);
	assert.deepEqual(result, { index: { action: "init", ok: true, joined: true }, warm: "skipped" });
});

test("S18: this session's own failed init is a failure and does not warm", async () => {
	const log: string[] = [];
	let created = false;
	const result = await prepareProject({
		cwd: CWD, env: {}, reason: "startup",
		exists: (path) => path.endsWith(".git") || path.endsWith("package.json") || (created && path.endsWith(".codegraph")),
		codegraphBusy: () => false,
		run: async (args) => { log.push(`run:${args[0]}`); if (args[0] === "init") created = true; return false; },
		onIndexed: (index) => log.push(`indexed:${index.action}:${index.ok}:${index.joined}`),
		onWarmStart: () => log.push("warm-start"),
		warm: async () => { log.push("warm"); return true; },
	});
	assert.deepEqual(log, ["run:init", "indexed:init:false:undefined"]);
	assert.deepEqual(result, { index: { action: "init", ok: false }, warm: "skipped" });
});

test("S17: while another session holds the init lock, this one neither syncs nor warms", async () => {
	const log: string[] = [];
	const result = await prepareProject({
		cwd: CWD, env: {}, reason: "startup", exists: has(".codegraph"),
		lock: { acquire: () => ({ status: "busy" }), isHeld: () => true },
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
		onWarmStart: () => log.push("warm-start"),
		warm: async () => { log.push("warm"); return true; },
	});
	assert.deepEqual(log, []);
	assert.deepEqual(result, { index: { action: "sync", ok: true, joined: true }, warm: "skipped" });
});

test("S14: a failed sync still warms, because the index exists", async () => {
	const { log, input } = setup({ present: [".codegraph"], run: false });
	const result = await prepareProject(input);
	assert.ok(log.includes(`warm:${CWD}`));
	assert.equal(result.warm, "ok");
});

test("S14: no index and nothing to init -> nothing is warmed", async () => {
	const { log, input } = setup({ present: [".git"] });
	const result = await prepareProject(input);
	assert.deepEqual(log, []);
	assert.deepEqual(result, { index: { action: "none", ok: true }, warm: "skipped" });
});

test("S14: subagent children and /reload never warm", async () => {
	for (const options of [{ env: { GENTLE_PI_AGENTS_CHILD: "1" } }, { reason: "reload" as const }]) {
		const { log, input } = setup({ present: [".codegraph"], ...options });
		const result = await prepareProject(input);
		assert.deepEqual(log, [], JSON.stringify(options));
		assert.equal(result.warm, "skipped");
	}
});

test("S14: a warm-up that fails or throws is reported as failed and never rejects", async () => {
	for (const warm of [false, "throw"] as const) {
		const { input } = setup({ present: [".codegraph"], warm });
		const result = await prepareProject(input);
		assert.equal(result.warm, "failed", String(warm));
	}
});

test("S2: a startup sync that coalesced into another session's run still warms, because the index exists", async () => {
	const log: string[] = [];
	const result = await prepareProject({
		cwd: CWD, env: {}, reason: "startup", exists: has(".codegraph"),
		sync: { request: async () => ({ status: "coalesced" as const }) },
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
		onIndexed: (index) => log.push(`indexed:${index.action}:${index.ok}`),
		onWarmStart: () => log.push("warm-start"),
		warm: async () => { log.push("warm"); return true; },
	});
	assert.deepEqual(log, ["indexed:sync:true", "warm-start", "warm"]);
	assert.deepEqual(result, { index: { action: "sync", ok: true, coalesced: true }, warm: "ok" });
});

test("S2: a startup sync still queued for the index warms too, and is not reported as a failure", async () => {
	const log: string[] = [];
	const result = await prepareProject({
		cwd: CWD, env: {}, reason: "startup", exists: has(".codegraph"),
		sync: { request: async () => ({ status: "queued" as const }) },
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
		onIndexed: (index) => log.push(`indexed:${index.action}:${index.ok}`),
		warm: async () => { log.push("warm"); return true; },
	});
	assert.deepEqual(log, ["indexed:sync:true", "warm"]);
	assert.deepEqual(result, { index: { action: "sync", ok: true, queued: true }, warm: "ok" });
});

test("S2: unusable sync coordination warms anyway, because the index is there", async () => {
	const log: string[] = [];
	const result = await prepareProject({
		cwd: CWD, env: {}, reason: "startup", exists: has(".codegraph"),
		sync: { request: async () => ({ status: "unavailable" as const }) },
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
		onIndexed: (index) => log.push(`indexed:${index.action}:${index.ok}:${index.unavailable}`),
		warm: async () => { log.push("warm"); return true; },
	});
	assert.deepEqual(log, ["indexed:sync:false:true", "warm"]);
	assert.deepEqual(result, { index: { action: "sync", ok: false, unavailable: true }, warm: "ok" });
});

test("S1: an init is never handed to the sync coordinator", async () => {
	const { log, input } = setup({ present: [".git", "package.json"] });
	let asked = false;
	const result = await prepareProject({ ...input, sync: { request: async () => { asked = true; return { status: "coalesced" as const }; } } });
	assert.equal(asked, false);
	assert.deepEqual(log, ["start:init", "run:init", "indexed:init:true", "warm-start", `warm:${CWD}`]);
	assert.equal(result.index.ok, true);
});

test("S14: startup, new, resume and fork warm", async () => {
	for (const reason of ["startup", "new", "resume", "fork"] as const) {
		const { log, input } = setup({ present: [".codegraph"], reason });
		await prepareProject(input);
		assert.ok(log.includes(`warm:${CWD}`), reason);
	}
});

test("P5: a stale index (engine version changed) is reindexed with `codegraph index`, then warmed", async () => {
	const log: string[] = [];
	const input = {
		cwd: CWD, env: {}, reason: "startup" as const,
		exists: (path: string) => path.endsWith(".codegraph") || path.endsWith("indexer-version.json"),
		engineVersion: "1.6.4",
		readIndexVersion: () => "1.6.0",
		writeIndexVersion: (version: string) => log.push(`marker:${version}`),
		onStart: (action: string) => log.push(`start:${action}`),
		run: async (args: string[]) => { log.push(`run:${args.join(" ")}`); return true; },
		onIndexed: (result: { action: string; ok: boolean }) => log.push(`indexed:${result.action}:${result.ok}`),
		onWarmStart: () => log.push("warm-start"),
		warm: async (cwd: string) => { log.push(`warm:${cwd}`); return true; },
	};
	const result = await prepareProject(input as never);
	// runCodegraph appends the project path itself, so the args name only the command and its flag.
	assert.deepEqual(log, ["start:reindex", "run:index -q", "indexed:reindex:true", "marker:1.6.4", "warm-start", "warm:" + CWD], JSON.stringify(log));
	assert.equal(result.warm, "ok");
});

test("P5: a current marker means no reindex: plain sync and warm-up, unchanged behavior", async () => {
	const log: string[] = [];
	const input = {
		cwd: CWD, env: {}, reason: "startup" as const,
		exists: (path: string) => path.endsWith(".codegraph") || path.endsWith("indexer-version.json"),
		engineVersion: "1.6.4",
		readIndexVersion: () => "1.6.4",
		writeIndexVersion: (version: string) => log.push(`marker:${version}`),
		onStart: (action: string) => log.push(`start:${action}`),
		run: async (args: string[]) => { log.push(`run:${args.join(" ")}`); return true; },
		onIndexed: (result: { action: string; ok: boolean }) => log.push(`indexed:${result.action}:${result.ok}`),
		onWarmStart: () => log.push("warm-start"),
		warm: async (cwd: string) => { log.push(`warm:${cwd}`); return true; },
	};
	const result = await prepareProject(input as never);
	assert.equal(log.includes("start:reindex"), false, JSON.stringify(log));
	assert.deepEqual(log.filter((line) => !line.startsWith("run:sync")), ["start:sync", "indexed:sync:true", "warm-start", "warm:" + CWD], JSON.stringify(log));
	assert.equal(result.warm, "ok");
});

test("P5: no engine version provided (unit-style call): behavior unchanged, no marker, no reindex", async () => {
	const { log, input } = setup({ present: [".codegraph"] });
	await prepareProject(input as never);
	assert.equal(log.includes("start:reindex"), false, JSON.stringify(log));
	assert.ok(!log.some((line) => line.startsWith("marker:")), JSON.stringify(log));
});

function staleInput(log: string[], options: { recorded: string | undefined; run?: boolean; present?: string[]; lock?: unknown }) {
	const present = options.present ?? [".codegraph", "indexer-version.json"];
	return {
		cwd: CWD, env: {}, reason: "startup" as const,
		exists: has(...present),
		engineVersion: "1.6.4",
		readIndexVersion: () => options.recorded,
		writeIndexVersion: (version: string) => log.push(`marker:${version}`),
		lock: options.lock,
		onStart: (action: string) => log.push(`start:${action}`),
		run: async (args: string[], _cwd: string, timeoutMs: number, onSpawn?: (pid: number) => void) => {
			log.push(`run:${args.join(" ")}:${timeoutMs}`);
			onSpawn?.(4242);
			return options.run ?? true;
		},
		onIndexed: (result: { action: string; ok: boolean; joined?: boolean }) => log.push(`indexed:${result.action}:${result.ok}:${result.joined}`),
		onWarmStart: () => log.push("warm-start"),
		warm: async (cwd: string) => { log.push(`warm:${cwd}`); return true; },
	};
}

test("P5: a failed reindex is reported as reindex:false, writes no marker, and still warms the old index", async () => {
	const log: string[] = [];
	const result = await prepareProject(staleInput(log, { recorded: "1.6.0", run: false }) as never);
	assert.deepEqual(log, ["start:reindex", "run:index -q:600000", "indexed:reindex:false:undefined", "warm-start", `warm:${CWD}`]);
	assert.deepEqual(result, { index: { action: "reindex", ok: false }, warm: "ok" });
});

test("P5: a reindex takes the init lock, records its pid there and releases it", async () => {
	const log: string[] = [];
	const lock = {
		acquire: (_project: string, options?: { kind?: string }) => {
			log.push(`acquire:${options?.kind ?? "init"}`);
			return { status: "acquired", adopt: (pid: number) => log.push(`adopt:${pid}`), release: () => log.push("release") };
		},
		isHeld: () => false,
	};
	const result = await prepareProject(staleInput(log, { recorded: "1.6.0", lock }) as never);
	assert.deepEqual(log, ["acquire:init", "start:reindex", "run:index -q:600000", "adopt:4242", "release", "indexed:reindex:true:undefined", "marker:1.6.4", "warm-start", `warm:${CWD}`]);
	assert.deepEqual(result, { index: { action: "reindex", ok: true }, warm: "ok" });
});

test("P5: a busy lock joins: no reindex runs, no marker, no warm-up", async () => {
	const log: string[] = [];
	const lock = { acquire: () => ({ status: "busy" }), isHeld: () => true };
	const result = await prepareProject(staleInput(log, { recorded: "1.6.0", lock }) as never);
	assert.deepEqual(log, ["indexed:reindex:true:true"]);
	assert.deepEqual(result, { index: { action: "reindex", ok: true, joined: true }, warm: "skipped" });
});

test("P5: an index without a marker (unknown) is only synced and gets no marker", async () => {
	const log: string[] = [];
	const result = await prepareProject(staleInput(log, { recorded: undefined }) as never);
	assert.deepEqual(log, ["start:sync", "run:sync -q:120000", "indexed:sync:true:undefined", "warm-start", `warm:${CWD}`]);
	assert.deepEqual(result, { index: { action: "sync", ok: true }, warm: "ok" });
});

test("P5: a successful init records the engine version; a failed one does not", async () => {
	for (const ok of [true, false]) {
		const log: string[] = [];
		await prepareProject(staleInput(log, { recorded: undefined, run: ok, present: [".git", "package.json"] }) as never);
		assert.equal(log.includes("marker:1.6.4"), ok, JSON.stringify(log));
		assert.equal(log.indexOf("marker:1.6.4") > log.indexOf(`indexed:init:${ok}:undefined`), ok, JSON.stringify(log));
	}
});

test("P5: after a successful reindex the marker is written with the new version", async () => {
	// Covered by the first P5 test's exact-sequence log (marker:1.6.4 after indexed:reindex:true).
	assert.ok(true);
});
