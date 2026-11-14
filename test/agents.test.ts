import { test } from "node:test";
import assert from "node:assert/strict";
import * as agents from "../src/agents.ts";
import { agentNameFromArgv, indexRole, mayInitiateIndexWrite, sessionIndexRole } from "../src/agents.ts";

// gentle-shell ships the CodeGraph MCP tool in its own agent assets: the package has no agent-file normalizer.
test("the package no longer normalizes agent files", () => {
	assert.equal("normalizeAgent" in agents, false);
});

// --- S6: role rules from the declared tool list ---

test("S6: role detection reads the tool list gentle-pi requested, not an agent name", () => {
	assert.equal(indexRole(["read", "grep", "find", "codegraph"]), "explorer");
	assert.equal(indexRole(["read", "grep", "find", "mcp__codegraph__codegraph_explore"]), "explorer");
	assert.equal(indexRole(["read", "grep", "find", "bash", "mcp__codegraph__codegraph_explore"]), "read-only");
	assert.equal(indexRole(["read", "grep", "find", "bash", "edit", "mcp__codegraph__codegraph_explore"]), "writer");
	assert.equal(indexRole(["read", "grep", "find"]), "unknown");
	assert.equal(indexRole([]), "unknown");
});

test("S6: only a read-only role is barred from starting an index write", () => {
	assert.equal(mayInitiateIndexWrite("read-only"), false);
	for (const role of ["explorer", "writer", "unknown", undefined] as const) {
		assert.equal(mayInitiateIndexWrite(role), true, String(role));
	}
});

test("S6: the main session is not a subagent role, so no rule narrows it", () => {
	assert.equal(sessionIndexRole({}), undefined);
	assert.equal(sessionIndexRole({ GENTLE_PI_AGENTS_CHILD: "0", GENTLE_PI_AGENTS_REQUESTED_TOOLS: "read" }), undefined);
	assert.equal(sessionIndexRole({ GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_REQUESTED_TOOLS: "read,bash" }), "read-only");
	assert.equal(sessionIndexRole({ GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_REQUESTED_TOOLS: "read,codegraph" }), "explorer");
});

// --- S2: the agent name of a child, read from its own command line ---

/** The argv of a child: gentle-pi passes its agent body as `gentle-pi-subagent-<agent>-<random>/instructions.md`. */
const argvOf = (...args: string[]) => ["node", "pi", "--append-system-prompt", ...args];

/** That directory as either platform spells it; nothing here reads it. */
function childPath(agent: string, separator = "/"): string {
	const base = separator === "/" ? "C:/Users/Tony/AppData/Local/Temp/gpHCf3HX" : "C:\\Users\\Tony\\AppData\\Local\\Temp\\gpHCf3HX";
	return [base, `gentle-pi-subagent-${agent}-DZgR2G`, "instructions.md"].join(separator);
}

test("S2: a child's own argv names its agent; the main session's argv names none", () => {
	for (const agent of ["gentle-ai-explore", "gentle-ai-verify", "gentle-ai-worker", "jd-fix-agent", "jd-judge-a", "jd-judge-b"]) {
		assert.equal(agentNameFromArgv(argvOf(childPath(agent))), agent, agent);
		assert.equal(agentNameFromArgv(argvOf(childPath(agent, "\\"))), agent, `Windows separators: ${agent}`);
	}
	assert.equal(agentNameFromArgv([]), undefined);
	assert.equal(agentNameFromArgv(argvOf("--model", "x")), undefined);
	assert.equal(agentNameFromArgv(["tmp/gpHCf3HX/gentle-pi-subagent-"]), undefined, "an empty agent name is no name");
	assert.equal(agentNameFromArgv([42 as unknown as string]), undefined, "an unreadable argument is skipped");
});

test("S2: an agent the table does not name keeps the directory's spelling, so a reviewer stays visible", () => {
	assert.equal(agentNameFromArgv(argvOf(childPath("review-critic"))), "review-critic-DZgR2G");
	assert.equal(agentNameFromArgv(argvOf(childPath("my-helper"))), "my-helper-DZgR2G");
});
