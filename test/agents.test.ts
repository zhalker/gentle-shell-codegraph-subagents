import { test } from "node:test";
import assert from "node:assert/strict";
import * as agents from "../src/agents.ts";
import { indexRole, mayInitiateIndexWrite, sessionIndexRole } from "../src/agents.ts";

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
