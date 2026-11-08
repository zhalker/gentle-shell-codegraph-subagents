import { test } from "node:test";
import assert from "node:assert/strict";
import { prefetchForExplorer } from "../src/prefetch.ts";

test("S5: the pre-fetch header says the daemon answered, not that codegraph explore ran", async () => {
	const text = await prefetchForExplorer({
		env: { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_REQUESTED_TOOLS: "read,mcp__codegraph__codegraph_explore" },
		prompt: "map how session discovery works",
		cwd: "C:\\project",
		exists: () => true,
		explore: async () => "TEXT",
	});
	assert.match(String(text), /^CodeGraph pre-fetch for your task/);
	assert.match(String(text), /daemon/);
	assert.doesNotMatch(String(text), /codegraph explore`/);
});
