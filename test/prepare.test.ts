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

test("S14: startup, new, resume and fork warm", async () => {
	for (const reason of ["startup", "new", "resume", "fork"] as const) {
		const { log, input } = setup({ present: [".codegraph"], reason });
		await prepareProject(input);
		assert.ok(log.includes(`warm:${CWD}`), reason);
	}
});
