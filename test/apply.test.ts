import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as apply from "../src/apply.ts";

const { readExposureWarning, readMissingServerWarning } = apply;

// A global configuration that really exposes the shipped explore tool.
const DIRECT = JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", toolExposure: { codegraph_explore: "direct" } } } }, null, 2) + "\n";

function agentDir(globalConfig?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pcs-agent-"));
	if (globalConfig !== undefined) writeFileSync(join(dir, "mcp.json"), globalConfig);
	return dir;
}

function projectDir(config?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pcs-project-"));
	if (config !== undefined) {
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "mcp.json"), config);
	}
	return dir;
}

// The writer is gone: these two reads are the whole module, so nothing here can edit an agent file or mcp.json.
test("the package no longer writes agent files or mcp.json: apply exposes only its two read-only warnings", () => {
	assert.deepEqual(Object.keys(apply).sort(), ["readExposureWarning", "readMissingServerWarning"]);
});

test("S19: exposure warning reads global and trusted project settings without changing them", () => {
	const dir = agentDir(DIRECT);
	const project = projectDir(JSON.stringify({ mcpServers: { codegraph: { toolExposure: { codegraph_explore: "hidden" } } } }));
	const config = readFileSync(join(project, ".pi", "mcp.json"), "utf8");
	assert.equal(readExposureWarning(dir, project, false), undefined);
	assert.equal(readExposureWarning(dir, project, true), "hidden");
	assert.equal(readFileSync(join(project, ".pi", "mcp.json"), "utf8"), config);
});

test("S19: a trusted project hiding the server warns when the global direct exception remains", () => {
	const dir = agentDir(DIRECT);
	const project = projectDir(JSON.stringify({ mcpServers: { codegraph: { exposure: "hidden" } } }));
	const config = readFileSync(join(project, ".pi", "mcp.json"), "utf8");
	assert.equal(readExposureWarning(dir, project, true), "hidden-with-direct");
	assert.equal(readFileSync(join(project, ".pi", "mcp.json"), "utf8"), config);
});

test("S21: a missing server is reported without creating a config; untrusted projects are ignored", () => {
	const dir = agentDir();
	const project = projectDir(JSON.stringify({ mcpServers: { codegraph: { command: "codegraph" } } }));
	const config = readFileSync(join(project, ".pi", "mcp.json"), "utf8");
	assert.equal(readMissingServerWarning(dir, project, false), true);
	assert.equal(readMissingServerWarning(dir, project, true), false);
	assert.equal(readMissingServerWarning(dir, project, false, true), false);
	assert.equal(existsSync(join(dir, "mcp.json")), false);
	assert.equal(readFileSync(join(project, ".pi", "mcp.json"), "utf8"), config);
});
