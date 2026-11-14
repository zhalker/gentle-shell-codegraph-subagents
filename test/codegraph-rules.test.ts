// S1/S2/S3/S4/S5: the approved wording of the CodeGraph rule ships as one Markdown file per role under
// `src/codegraph-rules/`, and each session reads the text of its own role from disk. The section is appended in
// place to the prompt options and never returned as a replacement prompt; it reaches only a session whose tools
// include the native `codegraph` tool or the MCP explore tool, and never a reviewer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendCodegraphSection,
	codegraphSection,
	createRuleTexts,
	isReviewerAgent,
	RULE_DIRECTORY,
	RULE_VARIANT_BY_AGENT,
	RULE_VARIANTS,
	ruleVariant,
	SECTION_MARKER,
	type RuleVariant,
} from "../src/codegraph-rules.ts";
import { agentNameFromArgv, RULE_AGENT_NAMES } from "../src/agents.ts";

const MCP = "mcp__codegraph__codegraph_explore";
const NATIVE = "codegraph";

/** The shipped text of one variant, exactly as the code must produce it: the file itself, without its newline. */
function fileText(variant: RuleVariant): string {
	return readFileSync(join(RULE_DIRECTORY, `${variant}.md`), "utf8").trimEnd();
}

/** The argv gentle-pi gives a child: its agent body lives in `gentle-pi-subagent-<agent>-<random>`. */
function childArgv(agent: string): string[] {
	return ["--append-system-prompt", join(tmpdir(), "gp1DMHZs", `gentle-pi-subagent-${agent}-DZgR2G`, "instructions.md")];
}

test("S1: every variant text is the file it names, and every file opens with the heading", () => {
	for (const variant of RULE_VARIANTS) {
		const text = fileText(variant);
		assert.ok(text.startsWith(SECTION_MARKER), `${variant}.md opens with the section heading`);
		assert.ok(text.length < 8192, `${variant}.md stays bounded`);
	}
	const texts = createRuleTexts();
	for (const variant of RULE_VARIANTS) assert.equal(texts(variant), fileText(variant), variant);
});

test("S2: each gentle-shell agent gets its own text, read from the agent name in its own argv", () => {
	const expected: Record<string, RuleVariant> = {
		"gentle-ai-explore": "explore",
		"gentle-ai-verify": "verify",
		"gentle-ai-worker": "worker",
		"jd-fix-agent": "fix",
		"jd-judge-a": "judge",
		"jd-judge-b": "judge",
	};
	for (const [agent, variant] of Object.entries(expected)) {
		const name = agentNameFromArgv(childArgv(agent));
		assert.equal(name, agent, `the agent name is cut out of the child's own argv: ${agent}`);
		assert.equal(ruleVariant({ child: true, agent }), variant, agent);
		assert.equal(codegraphSection({ tools: [MCP], child: true, agent }), fileText(variant), agent);
	}
	assert.deepEqual([...Object.keys(RULE_VARIANT_BY_AGENT)].sort(), [...RULE_AGENT_NAMES].sort(), "one table of agents, no drift");
});

test("S2: a primary session gets the orchestrator text; a child gets the generic one, whatever its name", () => {
	assert.equal(ruleVariant({}), "orchestrator");
	assert.equal(codegraphSection({ tools: [NATIVE] }), fileText("orchestrator"));
	assert.equal(codegraphSection({ tools: [NATIVE], child: false, agent: "gentle-ai-worker" }), fileText("orchestrator"), "a primary session's own argv names no agent");

	assert.equal(codegraphSection({ tools: [MCP], child: true, agent: agentNameFromArgv(childArgv("my-helper")) }), fileText("generic"));
	assert.equal(codegraphSection({ tools: [MCP], child: true, agent: "my-helper-DZgR2G" }), fileText("generic"), "a name the table does not carry");
	assert.equal(codegraphSection({ tools: [MCP], child: true }), fileText("generic"), "a child whose agent name could not be read");
});

test("S2: a text for a role that holds only the MCP tool never offers a native `codegraph` operation", () => {
	// gentle-shell's own allowlist gives the native `codegraph` tool to the orchestrator and the explorer only;
	// the worker, the fix agent, the verifier and the judges hold `mcp__codegraph__codegraph_explore` alone, so
	// `init`, `query` and `explore` are no operation of theirs and their approved text names none of them.
	const MCP_ONLY: readonly RuleVariant[] = ["worker", "fix", "verify", "judge"];
	for (const variant of MCP_ONLY) {
		assert.doesNotMatch(fileText(variant), /operation: "init"/, `${variant}.md names no native operation`);
		assert.doesNotMatch(fileText(variant), /`query`|`explore`/, `${variant}.md names no native operation`);
	}
	// The two roles that do hold the native tool name it, so the check above is not vacuous.
	for (const variant of ["orchestrator", "explore"] as const) {
		assert.match(fileText(variant), /operation: "init"/, `${variant}.md names the native operation it holds`);
	}
});

test("S2: a missing, unreadable or heading-less file falls back to the generic text; a missing generic text is no section", () => {
	const onlyGeneric = createRuleTexts((file) => {
		if (file.endsWith("generic.md")) return `${SECTION_MARKER}\n\nGeneric text.`;
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	});
	assert.equal(onlyGeneric("explore"), `${SECTION_MARKER}\n\nGeneric text.`);
	assert.equal(codegraphSection({ tools: [MCP], child: true, agent: "gentle-ai-worker", rules: onlyGeneric }), `${SECTION_MARKER}\n\nGeneric text.`);

	const nothing = createRuleTexts(() => {
		throw new Error("unreadable");
	});
	assert.equal(nothing("generic"), undefined);
	assert.equal(codegraphSection({ tools: [MCP], rules: nothing }), undefined, "no text at all is no section, never a broken session");

	const headingless = createRuleTexts(() => "no heading here");
	assert.equal(headingless("verify"), undefined, "a text that does not open with the heading cannot be the section");
});

test("S2: a real directory that lacks the variant file still serves the generic text", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcs-rules-"));
	try {
		writeFileSync(join(dir, "generic.md"), `${SECTION_MARKER}\n\nGeneric from disk.\n`);
		const texts = createRuleTexts(undefined, dir);
		assert.equal(texts("judge"), `${SECTION_MARKER}\n\nGeneric from disk.`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S1: each file is read at most once per variant, and a read never throws", () => {
	const reads: string[] = [];
	const texts = createRuleTexts((file) => {
		reads.push(file);
		return `${SECTION_MARKER}\n\n${file}`;
	});
	texts("worker");
	texts("worker");
	codegraphSection({ tools: [MCP], child: true, agent: "gentle-ai-worker", rules: texts });
	assert.equal(reads.filter((path) => path.endsWith("worker.md")).length, 1, "one read per variant");
	assert.doesNotThrow(() => createRuleTexts(() => {
		throw new Error("boom");
	})("verify"));
});

test("S3: a session holding the native tool or the MCP tool gets the section; a session holding neither does not", () => {
	const text = fileText("orchestrator");
	assert.equal(codegraphSection({ tools: ["read", "grep", NATIVE] }), text);
	assert.equal(codegraphSection({ tools: ["read", MCP] }), text);
	assert.equal(codegraphSection({ tools: ["read", "mcp__codegraph__*"] }), text);
	assert.equal(codegraphSection({ tools: ["read", "grep", "find", "bash", "edit"] }), undefined, "a reviewer holds neither tool");
	assert.equal(codegraphSection({ tools: [] }), undefined);
	assert.equal(codegraphSection({ tools: ["mcp__other__tool"] }), undefined);
});

test("S3: a reviewer gets no section even when it holds the tool", () => {
	const agent = agentNameFromArgv(childArgv("review-critic"));
	assert.ok(agent !== undefined && isReviewerAgent(agent), "the reviewer's name still starts with `review-`");
	assert.equal(codegraphSection({ tools: [NATIVE, MCP], child: true, agent }), undefined);
	assert.equal(codegraphSection({ tools: [NATIVE, MCP], child: true, agent: "review-critic" }), undefined);
	assert.equal(isReviewerAgent("gentle-ai-verify"), false);
	assert.equal(isReviewerAgent(undefined), false);
});

test("S5: an indexed checkout says so in one line inside the section, not in a separate message", () => {
	const root = "C:\\project";
	const indexed = codegraphSection({ tools: [MCP], root });
	assert.equal(indexed, `${fileText("orchestrator")}\n\n- This workspace HAS a CodeGraph index at C:\\project; the extension verified that \`.codegraph/codegraph.db\` exists.`);
	const plain = codegraphSection({ tools: [MCP] });
	assert.ok(plain);
	assert.doesNotMatch(plain, /HAS a CodeGraph index/);
	assert.equal(codegraphSection({ tools: [MCP], root: "" }), fileText("orchestrator"), "an empty root is not an index");
});

test("S5: the section is appended after the existing prompt text and never added twice", () => {
	const SECTION = fileText("orchestrator");
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

test("S5: appending never throws and never replaces a prompt it cannot read", () => {
	const SECTION = fileText("verify");
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

test("S4: the exploration reminder is gone, with its wiring and its compaction reset", async () => {
	await assert.rejects(import("../src/exploration-reminder.ts"), (error: { code?: string }) => error.code === "ERR_MODULE_NOT_FOUND");
	const extension = readFileSync(join(import.meta.dirname, "..", "extensions", "index.ts"), "utf8");
	assert.doesNotMatch(extension, /exploration|EXPLORATION|observeToolCall|resetExplorationBudget/);
	assert.doesNotMatch(extension, /sendMessage|"tool_call"/, "the nudge and its hook are gone");
});
