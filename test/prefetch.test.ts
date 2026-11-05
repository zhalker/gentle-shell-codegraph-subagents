import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	QUERY_MAX_CHARS,
	boundOutput,
	isExplorerChild,
	prefetchForExplorer,
	runCommand,
	sanitizeQuery,
} from "../src/prefetch.ts";

const MCP = "mcp__codegraph__codegraph_explore";
const explorerEnv = {
	GENTLE_PI_AGENTS_CHILD: "1",
	GENTLE_PI_AGENTS_REQUESTED_TOOLS: `read,grep,find,${MCP},subagent_parent_message`,
};

test("S10: the explorer child is recognised by its read-only tool set with the CodeGraph MCP tool", () => {
	assert.equal(isExplorerChild(explorerEnv), true);
});

test("S10: sessions that are not subagent children are never the explorer", () => {
	assert.equal(isExplorerChild({ ...explorerEnv, GENTLE_PI_AGENTS_CHILD: undefined }), false);
	assert.equal(isExplorerChild({ ...explorerEnv, GENTLE_PI_AGENTS_CHILD: "0" }), false);
	assert.equal(isExplorerChild({}), false);
});

test("S10: agents that can run commands or edit are not the explorer", () => {
	for (const extra of ["bash", "edit", "write", "bash_background"]) {
		const env = { ...explorerEnv, GENTLE_PI_AGENTS_REQUESTED_TOOLS: `read,${MCP},${extra}` };
		assert.equal(isExplorerChild(env), false, extra);
	}
});

test("S10: agents without the CodeGraph MCP tool are not the explorer", () => {
	assert.equal(isExplorerChild({ ...explorerEnv, GENTLE_PI_AGENTS_REQUESTED_TOOLS: "read,grep,find,gentle_review_scope" }), false);
	assert.equal(isExplorerChild({ ...explorerEnv, GENTLE_PI_AGENTS_REQUESTED_TOOLS: undefined }), false);
});

test("the query keeps words, accents, digits and safe punctuation but loses shell metacharacters", () => {
	const dirty = 'find the "auth" flow & rm -rf / | echo $(whoami) `x` %PATH% ^y ; <a> !b \\ c\u00f1 caf\u00e9 v2.1_x';
	const clean = sanitizeQuery(dirty);
	for (const bad of ['"', "'", "&", "|", "$", "(", ")", "`", "%", "^", ";", "<", ">", "!", "\\"]) {
		assert.ok(!clean.includes(bad), `still has ${bad}: ${clean}`);
	}
	assert.ok(clean.includes("auth") && clean.includes("c\u00f1") && clean.includes("caf\u00e9") && clean.includes("v2.1_x"), clean);
	assert.equal(clean, clean.replace(/\s{2,}/g, " ").trim(), "spaces collapsed and trimmed");
});

test("the query is capped and an empty task gives an empty query", () => {
	assert.ok(sanitizeQuery("word ".repeat(500)).length <= QUERY_MAX_CHARS);
	assert.equal(sanitizeQuery("   "), "");
	assert.equal(sanitizeQuery("&|;"), "");
});

test("output within the limit is kept and longer output is cut with a marker", () => {
	assert.equal(boundOutput("short", 100), "short");
	const cut = boundOutput("x".repeat(500), 100);
	assert.ok(cut.startsWith("x".repeat(100)));
	assert.ok(cut.length < 200);
	assert.match(cut, /truncated/i);
});

test("runCommand returns the output of a command that succeeds", async () => {
	const out = await runCommand({ command: process.execPath, args: ["-e", "console.log('hello graph')"], cwd: tmpdir(), timeoutMs: 10_000, maxBytes: 10_000 });
	assert.equal(out?.trim(), "hello graph");
});

test("runCommand gives undefined when the command fails, is missing or prints nothing", async () => {
	const base = { cwd: tmpdir(), timeoutMs: 10_000, maxBytes: 10_000 };
	assert.equal(await runCommand({ ...base, command: process.execPath, args: ["-e", "process.exit(3)"] }), undefined);
	assert.equal(await runCommand({ ...base, command: "definitely-not-a-real-command-xyz", args: [] }), undefined);
	assert.equal(await runCommand({ ...base, command: process.execPath, args: ["-e", ""] }), undefined);
});

test("runCommand gives up after the timeout instead of waiting for the command", async () => {
	const started = Date.now();
	const out = await runCommand({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], cwd: tmpdir(), timeoutMs: 400, maxBytes: 10_000 });
	assert.equal(out, undefined);
	assert.ok(Date.now() - started < 5_000, "returned long before the 30 s the command wanted");
});

test("runCommand stops reading past the byte limit", async () => {
	const script = join(mkdtempSync(join(tmpdir(), "pcs-run-")), "big.js");
	writeFileSync(script, "process.stdout.write('y'.repeat(200000))");
	const out = await runCommand({ command: process.execPath, args: [script], cwd: tmpdir(), timeoutMs: 10_000, maxBytes: 1_000 });
	assert.ok(out === undefined || out.length <= 1_000, `got ${out?.length}`);
});

const base = (over: Partial<Parameters<typeof prefetchForExplorer>[0]> = {}) => ({
	env: explorerEnv,
	prompt: "map how session discovery works",
	cwd: "C:\\project",
	exists: () => true,
	explore: async () => "SYMBOLS",
	...over,
});

test("S10: the explorer gets the CodeGraph output as a message with the query it asked", async () => {
	let seen: { query: string; cwd: string } | undefined;
	const text = await prefetchForExplorer(base({ explore: async (query, cwd) => { seen = { query, cwd }; return "SYMBOLS"; } }));
	assert.deepEqual(seen, { query: "map how session discovery works", cwd: "C:\\project" });
	assert.ok(text?.includes("SYMBOLS"));
	assert.ok(text?.includes(MCP), "tells the model where to ask for more");
});

test("S10: without a .codegraph index nothing is fetched and the run continues as usual", async () => {
	let called = false;
	const text = await prefetchForExplorer(base({ exists: () => false, explore: async () => { called = true; return "X"; } }));
	assert.equal(text, undefined);
	assert.equal(called, false);
});

test("S10: the index is looked up in the project's .codegraph folder", async () => {
	const looked: string[] = [];
	await prefetchForExplorer(base({ cwd: join("C:", "project"), exists: (p) => { looked.push(p); return false; } }));
	assert.deepEqual(looked, [join("C:", "project", ".codegraph")]);
});

test("S10: other agents are left alone", async () => {
	let called = false;
	const text = await prefetchForExplorer(base({ env: { ...explorerEnv, GENTLE_PI_AGENTS_REQUESTED_TOOLS: `read,bash,${MCP}` }, explore: async () => { called = true; return "X"; } }));
	assert.equal(text, undefined);
	assert.equal(called, false);
});

test("S18: while this project's init is running, the explorer prefetch touches nothing", async () => {
	let called = false;
	const text = await prefetchForExplorer(base({ initRunning: () => true, explore: async () => { called = true; return "X"; } }));
	assert.equal(text, undefined);
	assert.equal(called, false);
});

test("S18: with no init running the explorer prefetch explores the project of its cwd as always", async () => {
	const looked: string[] = [];
	const text = await prefetchForExplorer(base({ initRunning: (cwd) => { looked.push(cwd); return false; }, explore: async () => "SYMBOLS" }));
	assert.deepEqual(looked, ["C:\\project"]);
	assert.ok(text?.includes("SYMBOLS"));
});

test("S18: an init lock that cannot be read leaves the run as it was", async () => {
	let called = false;
	const text = await prefetchForExplorer(base({ initRunning: () => { throw new Error("boom"); }, explore: async () => { called = true; return "X"; } }));
	assert.equal(text, undefined);
	assert.equal(called, false);
});

test("S10: a failing, empty or throwing CodeGraph changes nothing", async () => {
	assert.equal(await prefetchForExplorer(base({ explore: async () => undefined })), undefined);
	assert.equal(await prefetchForExplorer(base({ explore: async () => "   " })), undefined);
	assert.equal(await prefetchForExplorer(base({ explore: async () => { throw new Error("boom"); } })), undefined);
});

test("S10: a missing or empty task fetches nothing", async () => {
	let called = false;
	const explore = async () => { called = true; return "X"; };
	assert.equal(await prefetchForExplorer(base({ prompt: undefined, explore })), undefined);
	assert.equal(await prefetchForExplorer(base({ prompt: "&|;", explore })), undefined);
	assert.equal(called, false);
});

test("S10: oversized output is cut before it reaches the model", async () => {
	const text = await prefetchForExplorer(base({ explore: async () => "z".repeat(100_000) }));
	assert.ok(text !== undefined && text.length < 20_000, `length ${text?.length}`);
});
