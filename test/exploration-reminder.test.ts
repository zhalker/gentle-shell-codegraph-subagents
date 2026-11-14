// S6/S7: one reminder on the first search-shaped call of a session that can call CodeGraph but has not called it
// yet. It is never a veto (`observeToolCall` only returns text), it fires at most once per session, it starts over
// after a compaction, and it never throws. The primary session and a read-only explorer-style child get it; a
// child that writes files does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createExplorationBudget,
	EXPLORATION_REMINDER,
	observeToolCall,
	reminderAudience,
	resetExplorationBudget,
	searchesInBash,
} from "../src/exploration-reminder.ts";

const MCP = "mcp__codegraph__codegraph_explore";
const NATIVE = "codegraph";
const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolName, input });

test("S6: the first search-shaped call is reminded once, and never again in the same budget", () => {
	const budget = createExplorationBudget();
	assert.equal(observeToolCall(budget, call("grep", { pattern: "x" })), EXPLORATION_REMINDER);
	assert.equal(observeToolCall(budget, call("grep", { pattern: "y" })), undefined);
	assert.equal(observeToolCall(budget, call("find", { pattern: "*.ts" })), undefined);
	assert.equal(observeToolCall(budget, call("ls", { path: "." })), undefined);
	assert.equal(observeToolCall(budget, call("bash", { command: "rg foo" })), undefined);
});

test("S6: after a CodeGraph call, native or MCP, a search is not reminded", () => {
	for (const toolName of [NATIVE, MCP]) {
		const budget = createExplorationBudget();
		assert.equal(observeToolCall(budget, call(toolName, { operation: "explore" })), undefined);
		assert.equal(observeToolCall(budget, call("grep", { pattern: "x" })), undefined, toolName);
	}
});

test("S6: only grep, find, ls and a bash command that searches are search-shaped", () => {
	const budget = createExplorationBudget();
	for (const [name, input] of [
		["read", { path: "src/a.ts" }],
		["write", { path: "src/a.ts" }],
		["bash", { command: "npm test" }],
		["bash", { command: "git status" }],
		["bash", { command: "node scripts/build.js" }],
		["powershell", { command: "Get-Process" }],
	] as const) {
		assert.equal(observeToolCall(budget, call(name, input)), undefined, `${name} ${JSON.stringify(input)}`);
	}
	assert.equal(budget.reminded, false);
});

test("S6: a shell command that searches is recognised through pipes, options and paths", () => {
	for (const command of [
		"grep -rn codegraph src",
		"rg --files",
		"cat package.json | grep name",
		"find . -name '*.ts'",
		"fd codegraph",
		"ls -la",
		"git status && ls",
		"/usr/bin/grep -R x .",
		"/usr/bin/ls src",
		"Get-ChildItem -Recurse",
		"dir /b",
	]) {
		assert.equal(searchesInBash(command), true, command);
	}
	for (const command of ["npm test", "git status", "node scripts/run-tests.mjs", "", "mkdir -p build", "cat file.txt"]) {
		assert.equal(searchesInBash(command), false, command);
	}
	assert.equal(searchesInBash(undefined), false);
	assert.equal(searchesInBash(42), false);
});

test("S6: a compaction resets the budget, so one fresh reminder can follow", () => {
	const budget = createExplorationBudget();
	assert.equal(observeToolCall(budget, call("grep", { pattern: "x" })), EXPLORATION_REMINDER);
	assert.equal(observeToolCall(budget, call("codegraph", { operation: "explore" })), undefined);
	resetExplorationBudget(budget);
	assert.equal(budget.codegraphCalled, false, "a CodeGraph call before the compaction no longer counts");
	assert.equal(observeToolCall(budget, call("find", { pattern: "*.ts" })), EXPLORATION_REMINDER);
	assert.equal(observeToolCall(budget, call("find", { pattern: "*.js" })), undefined, "still once per budget");
});

test("S6: the primary session and a read-only explorer-style child are reminded; a writer is not", () => {
	const child = (tools: string) => ({ GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_REQUESTED_TOOLS: tools });
	assert.equal(reminderAudience({}), true, "the primary session");
	assert.equal(reminderAudience({ GENTLE_PI_AGENTS_CHILD: "0" }), true);
	assert.equal(reminderAudience(child(`read,grep,find,${MCP}`)), true, "the explorer");
	assert.equal(reminderAudience(child(`read,grep,find,bash,${MCP}`)), true, "verify and the judges");
	assert.equal(reminderAudience(child(`read,grep,find,edit,${MCP}`)), false, "a worker writes files");
	assert.equal(reminderAudience(child("read,grep,find")), false, "a child without CodeGraph");
});

test("S7/S8: the reminder names the rule, stays bounded, and an unreadable call never throws or blocks", () => {
	assert.match(EXPLORATION_REMINDER, /## CodeGraph/);
	assert.match(EXPLORATION_REMINDER, /before `grep`, `find` or `ls`/);
	assert.match(EXPLORATION_REMINDER, /does not block/);
	assert.ok(EXPLORATION_REMINDER.length < 1_000, "one short message");

	const budget = createExplorationBudget();
	assert.equal(observeToolCall(budget, undefined), undefined);
	assert.equal(observeToolCall(budget, { toolName: 42 }), undefined);
	assert.equal(observeToolCall(budget, { toolName: "bash", input: null }), undefined);
	assert.equal(budget.reminded, false, "nothing was mistaken for a search");

	// A budget that cannot be written is left alone instead of throwing into the session.
	const frozen = Object.freeze(createExplorationBudget());
	assert.doesNotThrow(() => observeToolCall(frozen, call("grep", { pattern: "x" })));
	assert.equal(observeToolCall(frozen, call("grep", { pattern: "x" })), undefined);
});
