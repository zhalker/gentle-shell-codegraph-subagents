import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEGRAPH_MCP_TOOL, normalizeAgent } from "../src/agents.ts";

const TOOL_BLOCK = `<!-- gentle-ai:pi-codegraph-tool -->
Use the Pi MCP proxy tool \`mcp\` for the read-only CodeGraph server.
<!-- /gentle-ai:pi-codegraph -->`;

const GUIDANCE_BLOCK = `<!-- gentle-ai:pi-codegraph-guidance -->
## CodeGraph

Use CodeGraph before broad filesystem searches.

8. Only fall back to normal filesystem tools after CodeGraph initialization or use fails.
<!-- /gentle-ai:pi-codegraph -->`;

// The blocks gentle-ai left in the file, which is what tells a frozen file apart.
const BLOCKS = `\n\n${TOOL_BLOCK}\n\n${GUIDANCE_BLOCK}`;

function agent(name: string, toolsLines: string, body: string): string {
	return `---\nname: ${name}\ndescription: test agent\n${toolsLines}\n---\n\n${body}\n`;
}

function toolsOf(text: string): string[] {
	const front = /^---\n([\s\S]*?)\n---/.exec(text)![1];
	const lines = front.split("\n");
	const i = lines.findIndex((line) => line.startsWith("tools:"));
	const inline = lines[i].slice("tools:".length).trim();
	if (inline.startsWith("[")) return inline.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
	if (inline) return inline.split(",").map((s) => s.trim()).filter(Boolean);
	const out: string[] = [];
	for (const line of lines.slice(i + 1)) {
		const m = /^\s*-\s+(.*)$/.exec(line);
		if (!m) break;
		out.push(m[1]);
	}
	return out;
}

test("S1: removes both gentle-ai CodeGraph blocks and leaves the rest of the body", () => {
	const input = agent("gentle-ai-verify", "tools: read, grep, find, bash, mcp", `You verify.\n\n${TOOL_BLOCK}\n\n${GUIDANCE_BLOCK}`);
	const output = normalizeAgent(input);
	assert.ok(!output.includes("gentle-ai:pi-codegraph"), "markers gone");
	assert.ok(!output.includes("Use CodeGraph before broad filesystem searches"), "guidance text gone");
	assert.ok(output.endsWith("You verify.\n"), `body kept and ends with one newline, got ${JSON.stringify(output.slice(-30))}`);
});

test("S3: a block-free file gets exactly the missing MCP tool appended for the six agents, nothing else", () => {
	const cases: Record<string, string> = {
		worker: agent("gentle-ai-worker", "tools: read, bash", "Worker instructions."),
		explorer: agent("gentle-ai-explore", "tools: read, grep, find, codegraph", "You explore."),
		// Only the tool is added: the broken `\"*\": false` entry and the dead `mcp` proxy entry stay.
		judge: agent("jd-judge-a", 'tools: *": false, read, grep, find, bash, mcp', "You judge."),
		withoutMcpTool: agent("gentle-ai-verify", "tools: read, grep, find, bash", "You verify.\n\nNothing about the graph here."),
	};
	for (const [label, input] of Object.entries(cases)) {
		const output = normalizeAgent(input);
		assert.notEqual(output, input, label);
		assert.ok(output.includes(CODEGRAPH_MCP_TOOL), label);
		// Exactly one edit: the body and every other frontmatter line are identical.
		const [inputFront, outputFront] = [input, output].map((text) => /^---\n([\s\S]*?)\n---/.exec(text)![1]);
		assert.deepEqual(outputFront.split("\n").filter((line) => !line.startsWith("tools:")), inputFront.split("\n").filter((line) => !line.startsWith("tools:")), label);
		assert.equal(output.slice(output.indexOf("\n---") + 1), input.slice(input.indexOf("\n---") + 1), label);
	}
	// A CRLF file keeps its line endings.
	const crlf = `---\r\nname: gentle-ai-verify\r\ndescription: x\r\ntools: read, mcp\r\n---\r\n\r\nYou verify.\r\n`;
	const crlfOut = normalizeAgent(crlf);
	assert.ok(crlfOut.includes(CODEGRAPH_MCP_TOOL));
	assert.ok(crlfOut.includes("\r\n"));
	// Outside the six, or already carrying the tool: byte for byte.
	const outsider = agent("some-other-agent", "tools: read, bash", "Other.");
	assert.equal(normalizeAgent(outsider), outsider);
	const hasTool = agent("gentle-ai-worker", `tools: read, ${CODEGRAPH_MCP_TOOL}`, "Worker instructions.");
	assert.equal(normalizeAgent(hasTool), hasTool);
});

test("S1: a block in the middle of the body is removed without gluing the neighbours", () => {
	const input = agent("gentle-ai-verify", "tools: read", `Before.\n\n${TOOL_BLOCK}\n\nAfter.`);
	const output = normalizeAgent(input);
	assert.ok(output.includes("Before.\n\nAfter."), JSON.stringify(output));
});

test("S2: a frozen explorer keeps its codegraph tool, gains the MCP tool, and keeps its own instruction lines", () => {
	const input = agent("gentle-ai-explore", "tools:\n  - read\n  - grep\n  - find\n  - codegraph", `You explore.\n${EXPLORER_BODY}${BLOCKS}`);
	const output = normalizeAgent(input);
	const tools = toolsOf(output);
	assert.ok(tools.includes("codegraph"), `keeps the extension tool, got ${JSON.stringify(tools)}`);
	assert.ok(tools.includes(CODEGRAPH_MCP_TOOL), `gets the MCP tool, got ${JSON.stringify(tools)}`);
	for (const line of EXPLORER_BODY.split("\n").filter(Boolean)) assert.ok(output.includes(line), line);
	assert.ok(!output.includes("gentle-ai:pi-codegraph"), "blocks gone");
});

test("S5: no worker marker is appended to the file", () => {
	const untouched = agent("gentle-ai-worker", "tools: read, bash", "Worker instructions.");
	const output = normalizeAgent(untouched);
	assert.ok(output.includes(CODEGRAPH_MCP_TOOL), "the missing tool is added");
	assert.ok(!output.includes("<!-- codegraph-workflow:worker -->"), output);
	const withBlocks = normalizeAgent(agent("gentle-ai-worker", "tools: read, bash", `Worker instructions.${BLOCKS}`));
	assert.ok(!withBlocks.includes("<!-- codegraph-workflow:worker -->"), output);
	assert.ok(!withBlocks.includes("gentle-ai:pi-codegraph"), output);
});

test("S2: other agents keep a codegraph tool they declare", () => {
	const input = agent("gentle-ai-worker", "tools: read, codegraph, bash", `You work.${BLOCKS}`);
	assert.deepEqual(toolsOf(normalizeAgent(input)), ["read", "codegraph", "bash", CODEGRAPH_MCP_TOOL]);
});

test("S3: verify, worker, fix agent and both judges receive the MCP tool", () => {
	for (const name of ["gentle-ai-verify", "gentle-ai-worker", "jd-fix-agent", "jd-judge-a", "jd-judge-b"]) {
		const out = normalizeAgent(agent(name, "tools: read, grep, find, bash", `Body.${BLOCKS}`));
		assert.ok(toolsOf(out).includes(CODEGRAPH_MCP_TOOL), `${name} should have the MCP tool`);
	}
});

test("S3: the MCP tool is never listed twice", () => {
	const input = agent("jd-judge-a", `tools: read, ${CODEGRAPH_MCP_TOOL}, bash`, `Body.${BLOCKS}`);
	assert.equal(toolsOf(normalizeAgent(input)).filter((t) => t === CODEGRAPH_MCP_TOOL).length, 1);
});

test("S4: the dead mcp entry is removed from the inline, bracket and list forms", () => {
	assert.deepEqual(toolsOf(normalizeAgent(agent("gentle-ai-verify", "tools: read, bash, mcp", `B.${BLOCKS}`))), ["read", "bash", CODEGRAPH_MCP_TOOL]);
	assert.deepEqual(toolsOf(normalizeAgent(agent("gentle-ai-verify", "tools: [read, bash, mcp]", `B.${BLOCKS}`))), ["read", "bash", CODEGRAPH_MCP_TOOL]);
	assert.deepEqual(toolsOf(normalizeAgent(agent("gentle-ai-verify", "tools:\n  - read\n  - mcp\n  - bash", `B.${BLOCKS}`))), ["read", "bash", CODEGRAPH_MCP_TOOL]);
});

test('S4: the broken `*": false` entry is removed in the flattened and list forms', () => {
	const flat = normalizeAgent(agent("jd-judge-a", 'tools: *": false, read, grep, find, bash, mcp', `B.${BLOCKS}`));
	assert.deepEqual(toolsOf(flat), ["read", "grep", "find", "bash", CODEGRAPH_MCP_TOOL]);
	const list = normalizeAgent(agent("jd-judge-b", 'tools:\n  - "*": false\n  - read\n  - bash', `B.${BLOCKS}`));
	assert.deepEqual(toolsOf(list), ["read", "bash", CODEGRAPH_MCP_TOOL]);
});

test("S5: review agents never receive the MCP tool but lose the blocks and the dead mcp entry", () => {
	for (const name of ["review-readability", "review-reliability", "review-resilience", "review-risk"]) {
		const input = agent(name, "tools:\n  - read\n  - grep\n  - gentle_review_scope\n  - mcp", `You review.${BLOCKS}`);
		const output = normalizeAgent(input);
		assert.deepEqual(toolsOf(output), ["read", "grep", "gentle_review_scope"], name);
		assert.ok(!output.includes("gentle-ai:pi-codegraph"), name);
	}
});

test("a frozen worker with no tools key keeps Pi's defaults", () => {
	const input = `---\nname: gentle-ai-worker\ndescription: x\n---\n\nBody.${BLOCKS}\n`;
	const output = normalizeAgent(input);
	assert.ok(!/^tools:/m.test(output));
	assert.ok(output.includes("Body."));
	assert.ok(!output.includes("gentle-ai:pi-codegraph"));
	assert.equal(normalizeAgent(output), output);
});

test("S7: normalizing twice changes nothing", () => {
	const input = agent("gentle-ai-explore", "tools:\n  - read\n  - codegraph\n  - mcp", `Body.${BLOCKS}`);
	const once = normalizeAgent(input);
	assert.equal(normalizeAgent(once), once);
});

test("text that is not an agent definition is returned unchanged", () => {
	assert.equal(normalizeAgent("no frontmatter here\n"), "no frontmatter here\n");
});

test("a frozen agent whose only tool is the dead mcp entry is not widened to Pi's defaults", () => {
	const input = agent("review-risk", "tools: mcp", `Body.${BLOCKS}`);
	assert.deepEqual(toolsOf(normalizeAgent(input)), ["mcp"]);
});

const EXPLORER_BODY = [
	"You are the read-only explorer.",
	"",
	'- For structural questions, use the cwd-scoped `codegraph` tool before broad filesystem searches. Initialize the workspace index with `operation: "init"` when it is absent, then use `query` or `explore`; never ask it to target another path.',
	"- `codegraph` may create or update only the current workspace `.codegraph/` index. This is the sole permitted mutation; all tracked files, source files, and other project content remain read-only.",
	"- If CodeGraph reports that it is unavailable or fails, then use `read`, `grep`, and `find` as the fallback. Do not use that fallback before CodeGraph is unavailable or fails.",
	"- Other than the explicit `.codegraph/` index exception, read and search only. Do not edit, write, run commands, or mutate state.",
	"- Do not fix findings, delegate to child agents, commit, or push.",
].join("\n");

test("S2: a frozen explorer keeps every shipped instruction line verbatim", () => {
	const output = normalizeAgent(agent("gentle-ai-explore", "tools: read, grep, find, codegraph", `${EXPLORER_BODY}${BLOCKS}`));
	for (const line of EXPLORER_BODY.split("\n").filter(Boolean)) assert.ok(output.includes(line), line);
	assert.equal(normalizeAgent(output), output);
});
