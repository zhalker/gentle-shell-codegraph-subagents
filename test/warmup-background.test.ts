// A background warm-up (the explorer's) must never keep its process alive; an awaited one (the session's
// autoindex) must still hold on until the server answers. Each probe is a fresh process, because only a
// process that has to exit can show what keeps it alive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WARMUP = new URL("../src/warmup.ts", import.meta.url).href;

function scratch(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function write(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	return path;
}

/** A command line exploreOnce can run in place of `codegraph serve --mcp`. */
function command(script: string): string {
	return `"${process.execPath}" "${script}"`;
}

function caller(dir: string, body: string[]): string {
	return write(dir, "caller.mjs", [`const warmup = await import(${JSON.stringify(WARMUP)});`, ...body, ""].join("\n"));
}

/** Runs the caller in a fresh process and reports how long it stayed alive and what it printed. */
function run(script: string, env: Record<string, string> = {}) {
	const started = Date.now();
	const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env } });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, elapsed: Date.now() - started };
}

/** A server that reads its stdin, never answers and lives for ten seconds. */
function hangServer(dir: string): string {
	return write(dir, "hang.mjs", [
		'import { createInterface } from "node:readline";',
		"createInterface({ input: process.stdin }).on(\"line\", () => {});",
		"setTimeout(() => {}, 10_000);",
		"",
	].join("\n"));
}

/** A server that answers both calls after `ms`. */
function slowServer(dir: string, ms: number): string {
	return write(dir, "server.mjs", [
		'import { createInterface } from "node:readline";',
		"const out = (message) => process.stdout.write(JSON.stringify(message) + \"\\n\");",
		"createInterface({ input: process.stdin }).on(\"line\", (line) => {",
		"\tconst message = JSON.parse(line);",
		`\tif (message.id === 1) setTimeout(() => out({ jsonrpc: "2.0", id: 1, result: {} }), ${ms});`,
		`\tif (message.id === 2) setTimeout(() => out({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "OK" }] } }), ${ms});`,
		"});",
		"",
	].join("\n"));
}

test("S15: a pending background warm-up never keeps its caller alive", () => {
	const dir = scratch("pcs-bg-hang-");
	const script = caller(dir, [`warmup.exploreOnce(${JSON.stringify(dir)}, "main", 60_000, ${JSON.stringify(command(hangServer(dir)))}, { background: true });`]);
	const result = run(script);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.elapsed < 5_000, `the caller stayed alive ${result.elapsed} ms`);
});

test("S14: an awaited warm-up still waits for its own timeout on a server that never answers", () => {
	const dir = scratch("pcs-bg-default-");
	const script = caller(dir, [`console.log(JSON.stringify(await warmup.exploreOnce(${JSON.stringify(dir)}, "main", 3_000, ${JSON.stringify(command(hangServer(dir)))})));`]);
	const result = run(script);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.elapsed >= 2_500, `the default mode left after ${result.elapsed} ms instead of waiting for its own timer`);
	assert.match(result.stdout, /"ok":false/);
});

test("S14: an awaited warm-up keeps the process until the server answers", () => {
	const dir = scratch("pcs-bg-awaited-");
	const script = caller(dir, [`console.log(JSON.stringify(await warmup.exploreOnce(${JSON.stringify(dir)}, "main", 15_000, ${JSON.stringify(command(slowServer(dir, 500)))})));`]);
	const result = run(script);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"ok":true/);
});

test("S15: a background warm-up still reads its server while the caller is alive", () => {
	const dir = scratch("pcs-bg-slow-");
	const script = caller(dir, [
		"const keep = setTimeout(() => {}, 20_000);",
		`const result = await warmup.exploreOnce(${JSON.stringify(dir)}, "main", 15_000, ${JSON.stringify(command(slowServer(dir, 400)))}, { background: true });`,
		"clearTimeout(keep);",
		"console.log(JSON.stringify(result));",
	]);
	const result = run(script);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"ok":true/);
});

test("S18: closing the warm-up hands the server every message, in order", () => {
	const dir = scratch("pcs-bg-eof-");
	const log = join(dir, "seen.log");
	const server = write(dir, "server.mjs", [
		'import { appendFileSync } from "node:fs";',
		'import { createInterface } from "node:readline";',
		"const out = (message) => process.stdout.write(JSON.stringify(message) + \"\\n\");",
		"const seen = [];",
		'createInterface({ input: process.stdin }).on("line", (line) => {',
		"\tconst message = JSON.parse(line);",
		"\tseen.push(message.method ?? \"id\" + message.id);",
		'\tif (message.id === 1) out({ jsonrpc: "2.0", id: 1, result: {} });',
		'\tif (message.id === 2) { appendFileSync(process.env.SEEN, JSON.stringify({ seen }) + "\\n"); out({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "OK" }] } }); }',
		"});",
		"",
	].join("\n"));
	const script = caller(dir, [`console.log(JSON.stringify(await warmup.exploreOnce(${JSON.stringify(dir)}, "main", 10_000, ${JSON.stringify(command(server))})));`]);
	const result = run(script, { SEEN: log });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"ok":true/);
	const first = JSON.parse(readFileSync(log, "utf8").split("\n")[0]);
	assert.deepEqual(first.seen, ["initialize", "notifications/initialized", "tools/call"]);
});
