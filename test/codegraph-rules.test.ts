// S2/S3/S4: the CodeGraph rule is one system-prompt section, appended in place to the prompt options and never
// returned as a replacement prompt. It reaches only a session whose tools include the native `codegraph` tool or
// the MCP explore tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendCodegraphSection, codegraphSection, RULE_BULLETS, SECTION_MARKER } from "../src/codegraph-rules.ts";

const MCP = "mcp__codegraph__codegraph_explore";
const NATIVE = "codegraph";

// The exact text recovered from the `codegraph-native` worktree (assets/orchestrator.md, assets/agents/gentle-ai-explore.md).
const RULE = [
	"- For structural questions — where something is defined, who calls it, how a flow works — use the cwd-scoped `codegraph` tool before symbol searches with `rg` or `grep` and before broad `find`. The same applies when the work is a refactor, a review, an analysis or a fix. `query` finds symbols; `explore` returns source plus call paths. Run `operation: \"init\"` first when the index is needed: it creates `.codegraph/` when absent and updates it when present. Never ask it to target another path.",
	"- `codegraph` may create or update only the current workspace `.codegraph/` index. This is the sole permitted mutation; all tracked files, source files, and other project content remain read-only.",
	"- If CodeGraph reports that it is unavailable or fails, then use `read`, `grep`, and `find` as the fallback. Do not use that fallback before CodeGraph is unavailable or fails.",
].join("\n");
const SECTION = `${SECTION_MARKER}\n\n${RULE}`;

test("S2: the section is the heading plus the three-bullet rule, byte for byte", () => {
	assert.deepEqual(RULE_BULLETS, RULE.split("\n"));
	assert.equal(codegraphSection({ tools: [NATIVE] }), SECTION);
	assert.ok(SECTION.length < 4096, "the fixed section stays bounded");
});

test("S4: a session holding the native tool or the MCP tool gets the section; a session holding neither does not", () => {
	assert.equal(codegraphSection({ tools: ["read", "grep", NATIVE] }), SECTION);
	assert.equal(codegraphSection({ tools: ["read", MCP] }), SECTION);
	assert.equal(codegraphSection({ tools: ["read", "mcp__codegraph__*"] }), SECTION);
	assert.equal(codegraphSection({ tools: ["read", "grep", "find", "bash", "edit"] }), undefined, "a reviewer holds neither tool");
	assert.equal(codegraphSection({ tools: [] }), undefined);
	assert.equal(codegraphSection({ tools: ["mcp__other__tool"] }), undefined);
});

test("S3: the section is appended after the existing prompt text and never added twice", () => {
	const plain = { systemPromptOptions: { appendSystemPrompt: "Existing instructions." } };
	appendCodegraphSection(plain, SECTION);
	assert.equal(plain.systemPromptOptions.appendSystemPrompt, `Existing instructions.\n\n${SECTION}`);
	appendCodegraphSection(plain, SECTION);
	assert.equal(plain.systemPromptOptions.appendSystemPrompt, `Existing instructions.\n\n${SECTION}`, "the heading is the idempotency marker");

	const oneNewline = { systemPromptOptions: { appendSystemPrompt: "Line.\n" } };
	appendCodegraphSection(oneNewline, SECTION);
	assert.equal(oneNewline.systemPromptOptions.appendSystemPrompt, `Line.\n\n${SECTION}`);

	const twoNewlines = { systemPromptOptions: { appendSystemPrompt: "Line.\n\n" } };
	appendCodegraphSection(twoNewlines, SECTION);
	assert.equal(twoNewlines.systemPromptOptions.appendSystemPrompt, `Line.\n\n${SECTION}`);

	const empty = { systemPromptOptions: { appendSystemPrompt: "" } };
	appendCodegraphSection(empty, SECTION);
	assert.equal(empty.systemPromptOptions.appendSystemPrompt, SECTION);

	const carried = { systemPromptOptions: { appendSystemPrompt: `Harness text.\n\n${SECTION}` } };
	appendCodegraphSection(carried, SECTION);
	assert.equal(carried.systemPromptOptions.appendSystemPrompt, `Harness text.\n\n${SECTION}`);
});

test("S3: appending never throws and never replaces a prompt it cannot read", () => {
	assert.doesNotThrow(() => appendCodegraphSection(undefined, SECTION));
	assert.doesNotThrow(() => appendCodegraphSection({}, SECTION));
	assert.doesNotThrow(() => appendCodegraphSection({ systemPromptOptions: undefined }, SECTION));

	const missing: { systemPromptOptions: { appendSystemPrompt?: unknown } } = { systemPromptOptions: {} };
	appendCodegraphSection(missing, SECTION);
	assert.equal(missing.systemPromptOptions.appendSystemPrompt, SECTION);

	const nonString: { systemPromptOptions: { appendSystemPrompt?: unknown } } = { systemPromptOptions: { appendSystemPrompt: 42 } };
	appendCodegraphSection(nonString, SECTION);
	assert.equal(nonString.systemPromptOptions.appendSystemPrompt, SECTION);

	const frozen = { systemPromptOptions: Object.freeze({ appendSystemPrompt: "Fixed." }) };
	assert.doesNotThrow(() => appendCodegraphSection(frozen, SECTION));
	assert.equal(frozen.systemPromptOptions.appendSystemPrompt, "Fixed.");

	const noSection = { systemPromptOptions: { appendSystemPrompt: "Fixed." } };
	assert.doesNotThrow(() => appendCodegraphSection(noSection, undefined));
	assert.equal(noSection.systemPromptOptions.appendSystemPrompt, "Fixed.");
});
