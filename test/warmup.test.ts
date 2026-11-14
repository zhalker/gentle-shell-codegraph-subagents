import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exploreOnce, warmUpDaemon } from "../src/warmup.ts";
import { daemonPids, hasCodegraph, indexedProject, stopDaemon } from "./helpers.ts";

// --- A fake MCP server over stdio: tests every reply shape without CodeGraph. ---

const FAKE_SERVER = fileURLToPath(new URL("./fake-mcp-server.ts", import.meta.url));
const WARMUP_WORKER = fileURLToPath(new URL("./warmup-worker.ts", import.meta.url));

/** The command line exploreOnce runs: the same shape as the real one, pointing at the fake server instead. */
function fakeServer(mode: string): string {
	return `"${process.execPath}" "${FAKE_SERVER}" ${mode}`;
}

function scratchDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("S14 real: warming a project leaves its daemon alive and the warm-up client gone", { skip: !hasCodegraph }, async () => {
	const dir = indexedProject();
	try {
		stopDaemon(dir);
		assert.equal(daemonPids(dir).length, 0);
		assert.equal(await warmUpDaemon(dir), true);
		assert.equal(daemonPids(dir).length, 1, "the daemon must survive the warm-up client");
	} finally {
		stopDaemon(dir);
	}
});

test("S14 real: after the warm-up, the first explore of the next client is much faster than on a cold daemon", { skip: !hasCodegraph }, async () => {
	const dir = indexedProject();
	try {
		stopDaemon(dir);
		const cold = await exploreOnce(dir, "warmFn1 run", 120_000);
		assert.equal(cold.ok, true);
		stopDaemon(dir);
		assert.equal(await warmUpDaemon(dir), true);
		const warm = await exploreOnce(dir, "warmFn1 run", 120_000);
		assert.equal(warm.ok, true);
		assert.ok(warm.exploreMs < cold.exploreMs * 0.7, `cold ${cold.exploreMs} ms, warm ${warm.exploreMs} ms`);
	} finally {
		stopDaemon(dir);
	}
});

test("S14 real: a directory without an index resolves false and never throws", { skip: !hasCodegraph }, async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pcs-warm-none-")));
	assert.equal(await warmUpDaemon(dir, 30_000), false);
});

test("S14: a timeout resolves false without waiting for the server", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pcs-warm-timeout-")));
	const started = Date.now();
	assert.equal(await warmUpDaemon(dir, 1), false);
	assert.ok(Date.now() - started < 5_000);
});

// --- Against the fake server ---

test("S18: an explore call with a text result is a warm-up", async () => {
	const result = await exploreOnce(scratchDir("pcs-warm-fake-"), "main", 10_000, fakeServer("ok"));
	assert.equal(result.ok, true);
});

test("S18: a reply with isError is a failed warm-up, so no 'ready' notice is shown", async () => {
	const result = await exploreOnce(scratchDir("pcs-warm-fake-"), "main", 10_000, fakeServer("isError"));
	assert.equal(result.ok, false);
});

test("S18: a reply with no content is a failed warm-up too", async () => {
	const result = await exploreOnce(scratchDir("pcs-warm-fake-"), "main", 10_000, fakeServer("empty"));
	assert.equal(result.ok, false);
});

test("S18: a stuck server's stdout is released, so it cannot keep the process alive after the timeout", async () => {
	const child = spawn(process.execPath, [WARMUP_WORKER, fakeServer("stuck")], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	let stderr = "";
	let killed = false;
	child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
	const guard = setTimeout(() => { killed = true; child.kill(); }, 6_000);
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	clearTimeout(guard);
	assert.match(output, /RESULT \{"ok":false/, `stdout ${output} stderr ${stderr}`);
	assert.equal(killed, false, "the worker never exited after the timeout: a stuck server's stdout kept it alive");
	assert.equal(code, 0, stderr);
});

// --- S4: reuse the checkout's live daemon before warming one ---

test("S4: a live daemon of this checkout is reused for the warm-up instead of spawning a server", async () => {
	// This directory has no index: a spawn here cannot succeed, so a true result proves the daemon was reused.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pcs-warm-reuse-")));
	const asked: { root: string; query: string }[] = [];
	assert.equal(await warmUpDaemon(dir, 5_000, {
		status: () => "live",
		ask: async (root, query) => { asked.push({ root, query }); return { status: "ok", text: "WARM" }; },
	}), true);
	assert.deepEqual(asked, [{ root: dir, query: "main" }], "the live daemon is asked once, for this checkout");
});

test("S4: a live daemon that does not answer is not doubled by a second server", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pcs-warm-timeout-live-")));
	let asked = 0;
	const started = Date.now();
	assert.equal(await warmUpDaemon(dir, 3_000, {
		status: () => "live",
		ask: async () => { asked++; return { status: "timeout" }; },
	}), false);
	assert.equal(asked, 1);
	assert.ok(Date.now() - started < 2_000, "the caller did not wait for a spawn that must not happen");
});

test("S4: with no live daemon for this checkout, nothing is asked and the server path runs", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pcs-warm-none-live-")));
	let asked = false;
	// The spawn path is real: a directory without an index cannot be served, so the answer is false.
	assert.equal(await warmUpDaemon(dir, 1, {
		status: () => "none",
		ask: async () => { asked = true; return { status: "ok", text: "X" }; },
	}), false);
	assert.equal(asked, false, "a checkout with no live daemon has nothing to ask");
});
