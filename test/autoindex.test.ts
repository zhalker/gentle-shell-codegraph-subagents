import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoIndex, codegraphWritingIndex, planIndexAction, runCodegraph } from "../src/autoindex.ts";
import { realInitLock } from "../src/initlock.ts";

type Calls = { args: string[]; cwd: string }[];

function fakeRun(calls: Calls, ok = true) {
	return async (args: string[], cwd: string) => {
		calls.push({ args, cwd });
		return ok;
	};
}

function withFiles(...present: string[]) {
	return (path: string) => present.some((name) => path.endsWith(name));
}

const CWD = join("some", "repo");

test("S11: with .codegraph in the directory where Pi starts, a new session runs `codegraph sync` there", async () => {
	const calls: Calls = [];
	const result = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".codegraph"), run: fakeRun(calls) });
	assert.deepEqual(calls, [{ args: ["sync", "-q"], cwd: CWD }]);
	assert.deepEqual(result, { action: "sync", ok: true });
});

test("S11: .codegraph present never triggers init, even with .git and package.json", async () => {
	const calls: Calls = [];
	await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".codegraph", ".git", "package.json"), run: fakeRun(calls) });
	assert.deepEqual(calls.map((call) => call.args), [["sync", "-q"]]);
});

test("S12: no .codegraph, .git and package.json -> `codegraph init -y`", async () => {
	const calls: Calls = [];
	const result = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", "package.json"), run: fakeRun(calls) });
	assert.deepEqual(calls, [{ args: ["init", "-y"], cwd: CWD }]);
	assert.deepEqual(result, { action: "init", ok: true });
});

test("S12: no .codegraph, .git and composer.json -> `codegraph init -y`", async () => {
	const calls: Calls = [];
	await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", "composer.json"), run: fakeRun(calls) });
	assert.deepEqual(calls.map((call) => call.args), [["init", "-y"]]);
});

test("S12: every other project marker next to .git also triggers init", async () => {
	for (const marker of ["pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts"]) {
		const calls: Calls = [];
		await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", marker), run: fakeRun(calls) });
		assert.deepEqual(calls.map((call) => call.args), [["init", "-y"]], marker);
		const noGit: Calls = [];
		await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(marker), run: fakeRun(noGit) });
		assert.deepEqual(noGit, [], `${marker} without .git`);
	}
});

test("S12: .git without any project marker does nothing", async () => {
	const calls: Calls = [];
	const result = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", "README.md"), run: fakeRun(calls) });
	assert.deepEqual(calls, []);
	assert.deepEqual(result, { action: "none", ok: true });
});

test("S12: package.json or composer.json without .git does nothing", async () => {
	const calls: Calls = [];
	await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles("package.json", "composer.json"), run: fakeRun(calls) });
	assert.deepEqual(calls, []);
});

test("planIndexAction is a pure decision over the three paths", () => {
	assert.equal(planIndexAction(CWD, withFiles(".codegraph")), "sync");
	assert.equal(planIndexAction(CWD, withFiles(".git", "package.json")), "init");
	assert.equal(planIndexAction(CWD, withFiles()), "none");
});

test("a subagent child never syncs or inits", async () => {
	const calls: Calls = [];
	const result = await autoIndex({ cwd: CWD, env: { GENTLE_PI_AGENTS_CHILD: "1" }, reason: "startup", exists: withFiles(".codegraph"), run: fakeRun(calls) });
	assert.deepEqual(calls, []);
	assert.equal(result.action, "none");
});

test("a /reload does nothing; startup, new, resume and fork do", async () => {
	for (const reason of ["reload"] as const) {
		const calls: Calls = [];
		await autoIndex({ cwd: CWD, env: {}, reason, exists: withFiles(".codegraph"), run: fakeRun(calls) });
		assert.deepEqual(calls, [], reason);
	}
	for (const reason of ["startup", "new", "resume", "fork"] as const) {
		const calls: Calls = [];
		await autoIndex({ cwd: CWD, env: {}, reason, exists: withFiles(".codegraph"), run: fakeRun(calls) });
		assert.equal(calls.length, 1, reason);
	}
});

test("a failing or throwing command is reported as not ok and never rejects", async () => {
	const failed = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".codegraph"), run: fakeRun([], false) });
	assert.deepEqual(failed, { action: "sync", ok: false });
	const thrown = await autoIndex({
		cwd: CWD, env: {}, reason: "startup", exists: withFiles(".codegraph"),
		run: async () => { throw new Error("boom"); },
	});
	assert.deepEqual(thrown, { action: "sync", ok: false });
});

test("onStart announces the action before the command runs, and only when one runs", async () => {
	for (const [present, expected] of [[[".codegraph"], "sync"], [[".git", "package.json"], "init"]] as const) {
		const order: string[] = [];
		await autoIndex({
			cwd: CWD, env: {}, reason: "startup", exists: withFiles(...present),
			onStart: (action) => order.push(`start:${action}`),
			run: async () => { order.push("run"); return true; },
		});
		assert.deepEqual(order, [`start:${expected}`, "run"]);
	}
	const silent: string[] = [];
	const skipped = [
		{ present: [".git"], env: {}, reason: "startup" as const },
		{ present: [".codegraph"], env: { GENTLE_PI_AGENTS_CHILD: "1" }, reason: "startup" as const },
		{ present: [".codegraph"], env: {}, reason: "reload" as const },
	];
	for (const { present, env, reason } of skipped) {
		await autoIndex({ cwd: CWD, env, reason, exists: withFiles(...present), onStart: (action) => silent.push(action), run: fakeRun([]) });
	}
	assert.deepEqual(silent, []);
});

test("a throwing onStart does not stop the command", async () => {
	const calls: Calls = [];
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup", exists: withFiles(".codegraph"),
		onStart: () => { throw new Error("ui gone"); },
		run: fakeRun(calls),
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(result, { action: "sync", ok: true });
});

test("S16: an init that fails while CodeGraph's own lock names a live process (another session got there first) is not a failure and nothing else is run", async () => {
	const calls: Calls = [];
	let created = false;
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup",
		exists: (path) => (path.endsWith(".git") || path.endsWith("package.json")) || (created && path.endsWith(".codegraph")),
		codegraphBusy: () => true,
		run: async (args, cwd) => {
			calls.push({ args, cwd });
			if (args[0] === "init") { created = true; return false; }
			return true;
		},
	});
	assert.deepEqual(calls.map((call) => call.args), [["init", "-y"]]);
	assert.deepEqual(result, { action: "init", ok: true, joined: true });
});

test("S18: an init of this session that creates .codegraph and fails is a failure, not a join", async () => {
	const calls: Calls = [];
	let created = false;
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup",
		exists: (path) => (path.endsWith(".git") || path.endsWith("package.json")) || (created && path.endsWith(".codegraph")),
		codegraphBusy: () => false,
		run: async (args, cwd) => {
			calls.push({ args, cwd });
			if (args[0] === "init") { created = true; return false; }
			return true;
		},
	});
	assert.deepEqual(calls.map((call) => call.args), [["init", "-y"]]);
	assert.deepEqual(result, { action: "init", ok: false });
});

test("S18: when another party created .codegraph after planning, this session joins without running or announcing", async () => {
	const log: string[] = [];
	let lookups = 0;
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup",
		// The first lookup is the plan; by the time this session has the lock, the index is there.
		exists: (path) => {
			if (path.endsWith(".codegraph")) { lookups++; return lookups > 1; }
			return path.endsWith(".git") || path.endsWith("package.json");
		},
		lock: fakeLock(log, false),
		onStart: (action) => log.push(`start:${action}`),
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
	});
	assert.deepEqual(log, ["lock:acquire", "lock:release"]);
	assert.deepEqual(result, { action: "init", ok: true, joined: true });
	assert.equal(lookups, 2);
});

test("S18: the join does not depend on having a lock: an index created after planning is left alone too", async () => {
	const calls: Calls = [];
	let lookups = 0;
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup",
		exists: (path) => {
			if (path.endsWith(".codegraph")) { lookups++; return lookups > 1; }
			return path.endsWith(".git") || path.endsWith("package.json");
		},
		run: fakeRun(calls),
	});
	assert.deepEqual(calls, []);
	assert.deepEqual(result, { action: "init", ok: true, joined: true });
});

test("S18: the pid of this session's init is adopted by the lock", async () => {
	const log: string[] = [];
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", "package.json"), lock: fakeLock(log, false),
		run: async (args, cwd, timeoutMs, onSpawn) => { log.push(`run:${args[0]}:${timeoutMs}`); onSpawn?.(4242); return true; },
	});
	assert.deepEqual(log, ["lock:acquire", "run:init:600000", "lock:adopt:4242", "lock:release"]);
	assert.deepEqual(result, { action: "init", ok: true });
});

test("S18: a pid that is only the shell around the init is recorded as a proxy, not as the init itself", async () => {
	const log: string[] = [];
	await autoIndex({
		cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", "package.json"), lock: fakeLock(log, false),
		run: async (args, cwd, timeoutMs, onSpawn) => { onSpawn?.(4242, { proxy: true }); return true; },
	});
	assert.ok(log.includes("lock:adopt:4242:proxy"), log.join(","));
});

const codegraphDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "pcs-cg-"));
	mkdirSync(join(dir, ".codegraph"));
	return dir;
};

test("S18: CodeGraph's own lock names the process writing the index, and counts only a live one", () => {
	const dir = codegraphDir();
	const lock = join(dir, ".codegraph", "codegraph.lock");
	writeFileSync(lock, String(process.pid));
	assert.equal(codegraphWritingIndex(dir), true);
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	writeFileSync(lock, String(dead));
	assert.equal(codegraphWritingIndex(dir), false, `dead pid ${dead}`);
	writeFileSync(lock, "not a pid");
	assert.equal(codegraphWritingIndex(dir), false);
	writeFileSync(lock, "");
	assert.equal(codegraphWritingIndex(dir), false);
	rmSync(lock);
	assert.equal(codegraphWritingIndex(dir), false);
	assert.equal(codegraphWritingIndex(join(dir, "nowhere")), false);
});

test("S18: a timed-out runCodegraph resolves only once the killed process is gone", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pcs-kill-"));
	const pidFile = join(dir, "fake.pid");
	writeFileSync(join(dir, "fake.js"), `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 120000);\n`);
	writeFileSync(join(dir, "codegraph.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake.js" %*\r\n`);
	const oldPath = process.env.PATH ?? "";
	process.env.PATH = `${dir};${oldPath}`;
	try {
		const started = Date.now();
		let spawned: { pid: number; proxy?: boolean } | undefined;
		assert.equal(await runCodegraph(["init", "-y"], dir, 500, (pid, options) => { spawned = { pid, proxy: options?.proxy }; }), false);
		assert.ok(spawned !== undefined && spawned.pid > 0, "the pid of the spawned command is reported");
		// On Windows `codegraph` runs through the npm shell shim, so that pid is the shell, not the init.
		assert.equal(spawned?.proxy, process.platform === "win32", JSON.stringify(spawned));
		assert.ok(Date.now() - started < 20_000, "did not wait long after killing");
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.ok(pid > 0, "the fake wrote its pid");
		assert.throws(() => process.kill(pid, 0), `the killed init (pid ${pid}) is gone`);
	} finally {
		process.env.PATH = oldPath;
	}
});

test("S16: a failed init without .codegraph is still a failure and nothing else is run", async () => {
	const calls: Calls = [];
	const result = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", "package.json"), run: fakeRun(calls, false) });
	assert.deepEqual(calls.map((call) => call.args), [["init", "-y"]]);
	assert.deepEqual(result, { action: "init", ok: false });
});

function fakeLock(log: string[], held: boolean) {
	return {
		acquire: () => {
			log.push("lock:acquire");
			return held
				? ({ status: "busy" } as const)
				: ({ status: "acquired", adopt: (pid: number, options?: { proxy?: boolean }) => log.push(`lock:adopt:${pid}${options?.proxy ? ":proxy" : ""}`), release: () => log.push("lock:release") } as const);
		},
		isHeld: () => { log.push("lock:isHeld"); return held; },
	};
}

test("S17: the init runs holding the lock, taken before anything is announced and released afterwards, whatever the outcome", async () => {
	for (const outcome of ["ok", "fail", "throw"] as const) {
		const log: string[] = [];
		const result = await autoIndex({
			cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", "package.json"), lock: fakeLock(log, false),
			onStart: (action) => log.push(`start:${action}`),
			run: async (args) => { log.push(`run:${args[0]}`); if (outcome === "throw") throw new Error("boom"); return outcome === "ok"; },
		});
		assert.deepEqual(log, ["lock:acquire", "start:init", "run:init", "lock:release"], outcome);
		assert.equal(result.action, "init", outcome);
		assert.equal(result.ok, outcome === "ok", outcome);
	}
});

test("S17: a session that finds the init lock held does nothing: no init, no announcement", async () => {
	const log: string[] = [];
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup", exists: withFiles(".git", "package.json"), lock: fakeLock(log, true),
		onStart: (action) => log.push(`start:${action}`),
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
	});
	assert.deepEqual(log, ["lock:acquire"]);
	assert.deepEqual(result, { action: "init", ok: true, joined: true });
});

test("S17: while another session holds the init lock, an existing .codegraph is not synced either", async () => {
	const log: string[] = [];
	const result = await autoIndex({
		cwd: CWD, env: {}, reason: "startup", exists: withFiles(".codegraph"), lock: fakeLock(log, true),
		onStart: (action) => log.push(`start:${action}`),
		run: async (args) => { log.push(`run:${args[0]}`); return true; },
	});
	assert.deepEqual(log, ["lock:isHeld"]);
	assert.deepEqual(result, { action: "sync", ok: true, joined: true });
});

test("S17: with no init lock held an existing index is synced as always", async () => {
	const log: string[] = [];
	const result = await autoIndex({ cwd: CWD, env: {}, reason: "startup", exists: withFiles(".codegraph"), lock: fakeLock(log, false), run: async (args) => { log.push(`run:${args[0]}`); return true; } });
	assert.deepEqual(log, ["lock:isHeld", "run:sync"]);
	assert.deepEqual(result, { action: "sync", ok: true });
});

test("S17: subagent children and /reload never even look at the lock", async () => {
	for (const options of [{ env: { GENTLE_PI_AGENTS_CHILD: "1" }, reason: "startup" as const }, { env: {}, reason: "reload" as const }]) {
		const log: string[] = [];
		await autoIndex({ cwd: CWD, ...options, exists: withFiles(".git", "package.json"), lock: fakeLock(log, false), run: async () => true });
		assert.deepEqual(log, [], JSON.stringify(options));
	}
});

// --- Real CodeGraph CLI: the promises, observed on disk and through the CLI. ---

const hasCommand = (command: string) => spawnSync(command, ["--version"], { shell: true, stdio: "ignore" }).status === 0;
const REAL = hasCommand("codegraph") && hasCommand("git");

function project(files: Record<string, string>, git: boolean): string {
	const dir = mkdtempSync(join(tmpdir(), "pcs-auto-"));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	if (git) spawnSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

const real = (cwd: string, reason: "startup" | "new" = "startup") =>
	autoIndex({ cwd, env: {}, reason, exists: existsSync, run: runCodegraph });

test("S12 real: git + package.json and no index -> init builds .codegraph with a database", { skip: !REAL }, async () => {
	const dir = project({ "package.json": "{}", "src/a.ts": "export function realInitFn(){return 1}\n" }, true);
	const result = await real(dir);
	assert.deepEqual(result, { action: "init", ok: true });
	assert.ok(existsSync(join(dir, ".codegraph", "codegraph.db")));
});

test("S12 real: git + composer.json and no index -> init builds .codegraph", { skip: !REAL }, async () => {
	const dir = project({ "composer.json": "{}", "src/a.php": "<?php function realPhpFn(){ return 1; }\n" }, true);
	assert.deepEqual(await real(dir), { action: "init", ok: true });
	assert.ok(existsSync(join(dir, ".codegraph", "codegraph.db")));
});

test("S12 real: no .git -> nothing is created", { skip: !REAL }, async () => {
	const dir = project({ "package.json": "{}", "src/a.ts": "export const a = 1\n" }, false);
	assert.deepEqual(await real(dir), { action: "none", ok: true });
	assert.equal(existsSync(join(dir, ".codegraph")), false);
});

test("S12 real: .git but no composer.json/package.json -> nothing is created", { skip: !REAL }, async () => {
	const dir = project({ "src/a.ts": "export const a = 1\n" }, true);
	assert.deepEqual(await real(dir), { action: "none", ok: true });
	assert.equal(existsSync(join(dir, ".codegraph")), false);
});

test("S11 real: a file added while no watcher ran is in the index after a new session's sync", { skip: !REAL }, async () => {
	const dir = project({ "package.json": "{}", "src/a.ts": "export function firstFn(){return 1}\n" }, true);
	await real(dir);
	const before = spawnSync("codegraph", ["status"], { cwd: dir, shell: true, encoding: "utf8" }).stdout;
	assert.match(before, /up to date/i);
	writeFileSync(join(dir, "src", "b.ts"), "export function addedLaterFn(){return 2}\n");
	const stale = spawnSync("codegraph", ["status"], { cwd: dir, shell: true, encoding: "utf8" }).stdout;
	assert.match(stale, /Added:\s+1/);
	assert.deepEqual(await real(dir, "new"), { action: "sync", ok: true });
	const after = spawnSync("codegraph", ["status"], { cwd: dir, shell: true, encoding: "utf8" }).stdout;
	assert.match(after, /up to date/i);
	const found = spawnSync("codegraph", ["explore", "addedLaterFn"], { cwd: dir, shell: true, encoding: "utf8" }).stdout;
	assert.match(found, /addedLaterFn/);
});

test("S11 real: sync handles removed and modified files too", { skip: !REAL }, async () => {
	const dir = project({ "package.json": "{}", "src/a.ts": "export function keepFn(){return 1}\n", "src/gone.ts": "export function goneFn(){return 1}\n" }, true);
	await real(dir);
	writeFileSync(join(dir, "src", "a.ts"), "export function keepFn(){return 2}\nexport function changedFn(){return 3}\n");
	const { rmSync } = await import("node:fs");
	rmSync(join(dir, "src", "gone.ts"));
	assert.deepEqual(await real(dir), { action: "sync", ok: true });
	const status = spawnSync("codegraph", ["status"], { cwd: dir, shell: true, encoding: "utf8" }).stdout;
	assert.match(status, /up to date/i);
	assert.match(spawnSync("codegraph", ["explore", "changedFn"], { cwd: dir, shell: true, encoding: "utf8" }).stdout, /changedFn/);
});

test("S11 real: an existing index is synced, not re-initialised (the database file is kept)", { skip: !REAL }, async () => {
	const dir = project({ "package.json": "{}", "src/a.ts": "export function oneFn(){return 1}\n" }, true);
	await real(dir);
	const marker = join(dir, ".codegraph", "keep-me.txt");
	writeFileSync(marker, "x");
	assert.equal((await real(dir)).action, "sync");
	assert.ok(existsSync(marker));
});

test("S16 real: two sessions starting an init at the same moment both end well and the index is complete", { skip: !REAL }, async () => {
	for (let round = 0; round < 3; round++) {
		const files: Record<string, string> = { "package.json": "{}" };
		for (let i = 0; i < 40; i++) files[`src/f${i}.ts`] = `export function raceFn${i}(){return ${i}}
`;
		const dir = project(files, true);
		// A hair apart, not at the very same instant: two inits started at the same instant can hang inside CodeGraph itself.
		const first = real(dir);
		const second = new Promise((resolve) => setTimeout(resolve, 300)).then(() => real(dir));
		const results = await Promise.all([first, second]);
		assert.deepEqual(results.map((result) => result.ok), [true, true], `round ${round}: ${JSON.stringify(results)}`);
		assert.ok(existsSync(join(dir, ".codegraph", "codegraph.db")));
		const status = spawnSync("codegraph", ["status"], { cwd: dir, shell: true, encoding: "utf8" }).stdout;
		assert.match(status, /up to date/i, `round ${round}`);
		assert.match(status, /Files:\s+40/, `round ${round}`);
	}
});

test("S17 real: two sessions starting an init at the very same instant: one creates the index, the other leaves it alone, nothing hangs", { skip: !REAL, timeout: 240_000 }, async () => {
	for (let round = 0; round < 5; round++) {
		const files: Record<string, string> = { "package.json": "{}" };
		for (let i = 0; i < 200; i++) files[`src/f${i}.ts`] = `export function sameFn${i}(){return ${i}}
`;
		const dir = project(files, true);
		const session = () => autoIndex({ cwd: dir, env: {}, reason: "startup", exists: existsSync, run: runCodegraph, lock: realInitLock });
		const results = await Promise.all([session(), session()]);
		assert.deepEqual(results.map((result) => result.ok), [true, true], `round ${round}: ${JSON.stringify(results)}`);
		assert.equal(results.filter((result) => result.joined).length, 1, `round ${round}: exactly one session joined: ${JSON.stringify(results)}`);
		const status = spawnSync("codegraph", ["status"], { cwd: dir, shell: true, encoding: "utf8" }).stdout;
		assert.match(status, /Files:\s+200/, `round ${round}`);
		assert.match(status, /up to date/i, `round ${round}`);
	}
});
