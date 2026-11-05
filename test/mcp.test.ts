import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMcpConfig, inspectMcpExposure, inspectEffectiveMcpExposure, isCodegraphServerMissing } from "../src/mcp.ts";

const base = (codegraph: Record<string, unknown>) =>
	JSON.stringify({ mcpServers: { codegraph, engram: { command: "node", lifecycle: "lazy" } }, other: 1 }, null, 2) + "\n";

test("S19: adds direct exposure for explore and keeps every other key", () => {
	const out = JSON.parse(normalizeMcpConfig(base({ command: "codegraph", args: ["serve", "--mcp"] })));
	assert.deepEqual(out.mcpServers.codegraph, { command: "codegraph", args: ["serve", "--mcp"], toolExposure: { codegraph_explore: "direct" } });
	assert.deepEqual(out.mcpServers.engram, { command: "node", lifecycle: "lazy" });
	assert.equal(out.other, 1);
});

test("S19: a server already direct keeps that exposure while selecting explore", () => {
	const input = '{"mcpServers":{"codegraph":{"command":"codegraph","exposure":"direct"}}}';
	const entry = JSON.parse(normalizeMcpConfig(input)).mcpServers.codegraph;
	assert.equal(entry.exposure, "direct");
	assert.equal(entry.toolExposure.codegraph_explore, "direct");
});

test("S19: codemode remains the server exposure", () => {
	const out = JSON.parse(normalizeMcpConfig(base({ command: "codegraph", exposure: "codemode" })));
	assert.equal(out.mcpServers.codegraph.exposure, "codemode");
	assert.equal(out.mcpServers.codegraph.toolExposure.codegraph_explore, "direct");
});

test("S6: a config without a codegraph server is left alone and none is created", () => {
	const input = JSON.stringify({ mcpServers: { engram: { command: "node" } } }, null, 2) + "\n";
	assert.equal(normalizeMcpConfig(input), input);
});

test("S6: a disabled codegraph server is left alone", () => {
	const input = base({ command: "codegraph", enabled: false });
	assert.equal(normalizeMcpConfig(input), input);
});

test("invalid or unexpected JSON is returned unchanged and never throws", () => {
	for (const input of ["", "not json", "[]", "null", '{"mcpServers":[]}', '{"mcpServers":{"codegraph":"x"}}']) {
		assert.equal(normalizeMcpConfig(input), input, JSON.stringify(input));
	}
});

test("S7: the file keeps its two-space indent and trailing newline, and a second pass changes nothing", () => {
	const once = normalizeMcpConfig(base({ command: "codegraph" }));
	assert.ok(once.includes('\n  "mcpServers": {'), once);
	assert.ok(once.endsWith("}\n"));
	assert.equal(normalizeMcpConfig(once), once);
});

test("S19: direct access is selected only for explore without changing the server exposure", () => {
	for (const exposure of [undefined, "codemode", "deferred", "direct"]) {
		const input = base({ command: "codegraph", ...(exposure ? { exposure } : {}), toolExposure: { other_tool: "hidden" } });
		const out = JSON.parse(normalizeMcpConfig(input));
		assert.equal(out.mcpServers.codegraph.exposure, exposure);
		assert.equal(out.mcpServers.codegraph.toolExposure.codegraph_explore, "direct");
		assert.equal(out.mcpServers.codegraph.toolExposure.other_tool, "hidden");
	}
});

test("S19: explicit incompatible explore settings are preserved and reported", () => {
	for (const exposure of ["codemode", "deferred", "hidden"]) {
		const input = base({ command: "codegraph", exposure: "codemode", toolExposure: { codegraph_explore: exposure } });
		assert.equal(normalizeMcpConfig(input), input);
		assert.equal(inspectMcpExposure(input), exposure);
	}
});

test("S19: hiding a server with a direct explore exception warns that explore remains exposed", () => {
	const input = base({ command: "codegraph", exposure: "hidden", toolExposure: { codegraph_explore: "direct" } });
	assert.equal(normalizeMcpConfig(input), input);
	assert.equal(inspectMcpExposure(input), "hidden-with-direct");
});

test("S19: an explicit direct explore setting remains unchanged", () => {
	const input = base({ command: "codegraph", exposure: "codemode", toolExposure: { codegraph_explore: "direct" } });
	assert.equal(normalizeMcpConfig(input), input);
	assert.equal(inspectMcpExposure(input), undefined);
});

test("S19: wildcard choices and disabled or hidden servers are preserved", () => {
	for (const entry of [
		{ command: "codegraph", toolExposure: { "codegraph_*": "hidden" } },
		{ command: "codegraph", exposure: "hidden" },
		{ command: "codegraph", enabled: false },
	]) {
		const input = base(entry);
		assert.equal(normalizeMcpConfig(input), input);
		assert.ok(inspectMcpExposure(input));
	}
});

test("S19: trusted project exposure overrides are inspected on top of global config", () => {
	const global = base({ command: "codegraph", toolExposure: { codegraph_explore: "direct" } });
	const project = JSON.stringify({ mcpServers: { codegraph: { toolExposure: { codegraph_explore: "hidden" } } } });
	assert.equal(inspectEffectiveMcpExposure(global, project), "hidden");
	assert.equal(inspectEffectiveMcpExposure(global), undefined);
});

test("S19: a project replacement with default exposure warns that direct access is unavailable", () => {
	const global = base({ command: "codegraph", toolExposure: { codegraph_explore: "direct" } });
	const project = JSON.stringify({ mcpServers: { codegraph: { command: "other" } } });
	assert.equal(inspectEffectiveMcpExposure(global, project), "codemode");
});

test("S19: a project server definition replaces the global definition", () => {
	const global = base({ command: "codegraph", toolExposure: { codegraph_explore: "hidden" } });
	const project = JSON.stringify({ mcpServers: { codegraph: { command: "other", toolExposure: { codegraph_explore: "direct" } } } });
	assert.equal(inspectEffectiveMcpExposure(global, project), undefined);
});

test("S21: a missing CodeGraph server is detected without modifying other server configuration", () => {
	const input = JSON.stringify({ mcpServers: { other: { command: "node" } } });
	assert.equal(isCodegraphServerMissing(input), true);
	assert.equal(normalizeMcpConfig(input), input);
	assert.equal(isCodegraphServerMissing("{}"), true);
});

test("S21: global, project or extension-registered CodeGraph servers are not missing", () => {
	assert.equal(isCodegraphServerMissing(base({ command: "codegraph" })), false);
	assert.equal(isCodegraphServerMissing("{}", base({ command: "codegraph" })), false);
	assert.equal(isCodegraphServerMissing("{}", undefined, true), false);
});

test("S21: a project-only override without a server definition remains missing", () => {
	const project = JSON.stringify({ mcpServers: { codegraph: { exposure: "direct" } } });
	assert.equal(isCodegraphServerMissing("{}", project), true);
});

test("S21: disabled or malformed settings are not misreported as an absent server", () => {
	assert.equal(isCodegraphServerMissing(base({ command: "codegraph", enabled: false })), false);
	assert.equal(isCodegraphServerMissing("not json"), false);
	assert.equal(isCodegraphServerMissing("{}", "not json"), false);
});

test("a tab-indented file keeps its tabs", () => {
	const input = '{\n\t"mcpServers": {\n\t\t"codegraph": {\n\t\t\t"command": "codegraph"\n\t\t}\n\t}\n}\n';
	assert.ok(normalizeMcpConfig(input).includes('\n\t"mcpServers"'));
});
