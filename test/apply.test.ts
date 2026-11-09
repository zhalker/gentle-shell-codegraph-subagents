import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { applyCodegraphSubagents, readExposureWarning, readMissingServerWarning } from "../src/apply.ts";
import { CODEGRAPH_MCP_TOOL } from "../src/agents.ts";

const VERIFY = `---\nname: gentle-ai-verify\ndescription: v\ntools: read, bash, mcp\n---\n\nYou verify.\n\n<!-- gentle-ai:pi-codegraph-tool -->\nUse the Pi MCP proxy tool \`mcp\`.\n<!-- /gentle-ai:pi-codegraph -->\n`;
const REVIEW = `---\nname: review-risk\ndescription: r\ntools:\n  - read\n  - mcp\n---\n\nYou review.\n\n<!-- gentle-ai:pi-codegraph-guidance -->\n## CodeGraph\n<!-- /gentle-ai:pi-codegraph -->\n`;
// A file gentle-ai never touched: it must come out byte for byte, or gentle-pi stops updating it.
const PLAIN = `---\nname: gentle-ai-worker\ndescription: w\ntools: read, bash\n---\n\nYou work.\n`;
const MCP = JSON.stringify({ mcpServers: { codegraph: { command: "codegraph" } } }, null, 2) + "\n";

function setup(): string {
	const dir = mkdtempSync(join(tmpdir(), "pcs-"));
	mkdirSync(join(dir, "agents"));
	mkdirSync(join(dir, "subagents"));
	writeFileSync(join(dir, "agents", "gentle-ai-verify.md"), VERIFY);
	writeFileSync(join(dir, "subagents", "review-risk.md"), REVIEW);
	writeFileSync(join(dir, "agents", "gentle-ai-worker.md"), PLAIN);
	writeFileSync(join(dir, "mcp.json"), MCP);
	return dir;
}

test("S7: rewrites agent files in agents/ and subagents/ and the mcp.json, and reports them", () => {
	const dir = setup();
	const result = applyCodegraphSubagents(dir);
	assert.deepEqual(result.errors, []);
	assert.equal(result.changed.length, 3);
	const verify = readFileSync(join(dir, "agents", "gentle-ai-verify.md"), "utf8");
	assert.ok(verify.includes(`tools: read, bash, ${CODEGRAPH_MCP_TOOL}`));
	assert.ok(!verify.includes("gentle-ai:pi-codegraph"));
	assert.ok(!readFileSync(join(dir, "subagents", "review-risk.md"), "utf8").includes("- mcp"));
	assert.equal(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.codegraph.toolExposure.codegraph_explore, "direct");
});

test("S3: a file without gentle-ai blocks is left byte for byte, with no backup and no report", () => {
	const dir = setup();
	const result = applyCodegraphSubagents(dir);
	assert.deepEqual(result.changed.sort(), [
		join(dir, "agents", "gentle-ai-verify.md"),
		join(dir, "mcp.json"),
		join(dir, "subagents", "review-risk.md"),
	].sort());
	assert.equal(readFileSync(join(dir, "agents", "gentle-ai-worker.md"), "utf8"), PLAIN);
	assert.equal(existsSync(join(dir, "agents", "gentle-ai-worker.md.pre-codegraph-subagents.bak")), false);
});

test("S7: a second run changes and writes nothing", () => {
	const dir = setup();
	applyCodegraphSubagents(dir);
	const before = readdirSync(join(dir, "agents")).sort();
	const again = applyCodegraphSubagents(dir);
	assert.deepEqual(again, { changed: [], errors: [] });
	assert.deepEqual(readdirSync(join(dir, "agents")).sort(), before);
});

test("the first rewrite keeps a backup of the original and later rewrites never replace it", () => {
	const dir = setup();
	applyCodegraphSubagents(dir);
	const backup = join(dir, "agents", "gentle-ai-verify.md.pre-codegraph-subagents.bak");
	assert.equal(readFileSync(backup, "utf8"), VERIFY);
	writeFileSync(join(dir, "agents", "gentle-ai-verify.md"), VERIFY.replace("You verify.", "You verify again."));
	applyCodegraphSubagents(dir);
	assert.equal(readFileSync(backup, "utf8"), VERIFY);
	assert.equal(readFileSync(join(dir, "mcp.json.pre-codegraph-subagents.bak"), "utf8"), MCP);
});

test("backups are not picked up as agent definitions and files that do not end in .md are ignored", () => {
	const dir = setup();
	writeFileSync(join(dir, "agents", "notes.txt"), VERIFY);
	applyCodegraphSubagents(dir);
	assert.equal(readFileSync(join(dir, "agents", "notes.txt"), "utf8"), VERIFY);
	const second = applyCodegraphSubagents(dir);
	assert.deepEqual(second.changed, []);
});

test("S19: exposure warning reads global and trusted project settings without changing them", () => {
	const dir = setup();
	const project = mkdtempSync(join(tmpdir(), "pcs-project-"));
	mkdirSync(join(project, ".pi"));
	const config = JSON.stringify({ mcpServers: { codegraph: { toolExposure: { codegraph_explore: "hidden" } } } });
	writeFileSync(join(project, ".pi", "mcp.json"), config);
	applyCodegraphSubagents(dir);
	assert.equal(readExposureWarning(dir, project, false), undefined);
	assert.equal(readExposureWarning(dir, project, true), "hidden");
	assert.equal(readFileSync(join(project, ".pi", "mcp.json"), "utf8"), config);
});

test("S19: a trusted project hiding the server warns when the global direct exception remains", () => {
	const dir = setup();
	const project = mkdtempSync(join(tmpdir(), "pcs-project-"));
	mkdirSync(join(project, ".pi"));
	const config = JSON.stringify({ mcpServers: { codegraph: { exposure: "hidden" } } });
	writeFileSync(join(project, ".pi", "mcp.json"), config);
	applyCodegraphSubagents(dir);
	assert.equal(readExposureWarning(dir, project, true), "hidden-with-direct");
	assert.equal(readFileSync(join(project, ".pi", "mcp.json"), "utf8"), config);
});

test("S21: a missing server is reported without creating a config; untrusted projects are ignored", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcs-agent-"));
	const project = mkdtempSync(join(tmpdir(), "pcs-project-"));
	mkdirSync(join(project, ".pi"));
	const config = JSON.stringify({ mcpServers: { codegraph: { command: "codegraph" } } });
	writeFileSync(join(project, ".pi", "mcp.json"), config);
	assert.equal(readMissingServerWarning(dir, project, false), true);
	assert.equal(readMissingServerWarning(dir, project, true), false);
	assert.equal(readMissingServerWarning(dir, project, false, true), false);
	assert.equal(existsSync(join(dir, "mcp.json")), false);
	assert.equal(readFileSync(join(project, ".pi", "mcp.json"), "utf8"), config);
});

test("a missing agent directory is not an error", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcs-empty-"));
	assert.deepEqual(applyCodegraphSubagents(dir), { changed: [], errors: [] });
	assert.deepEqual(applyCodegraphSubagents(join(dir, "does-not-exist")), { changed: [], errors: [] });
});

test("a file that cannot be read is reported and the other files are still processed", () => {
	const dir = setup();
	mkdirSync(join(dir, "agents", "broken.md"));
	const result = applyCodegraphSubagents(dir);
	assert.equal(result.errors.length, 1);
	assert.ok(result.errors[0].includes("broken.md"));
	assert.equal(result.changed.length, 3);
	assert.ok(existsSync(join(dir, "mcp.json.pre-codegraph-subagents.bak")));
});

function sessionApplying(dir: string, startAt: number): Promise<{ changed: string[]; errors: string[] }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(import.meta.dirname, "apply-worker.ts"), dir, String(startAt)], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.on("close", () => {
			try { resolve(JSON.parse(out)); } catch { resolve({ changed: [], errors: [`worker produced no result: ${out.slice(0, 80)}`] }); }
		});
	});
}

function manyAgentsDir(): { dir: string; names: string[]; originals: Record<string, string> } {
	const dir = setup();
	for (let i = 0; i < 6; i++) writeFileSync(join(dir, "agents", `gentle-ai-verify${i}.md`), VERIFY);
	// The untouched file is not rewritten and gets no backup, so it is not part of the concurrent rewrites.
	const names = [...readdirSync(join(dir, "agents")).map((entry) => join("agents", entry)).filter((entry) => entry !== join("agents", "gentle-ai-worker.md")), join("subagents", "review-risk.md"), "mcp.json"];
	return { dir, names, originals: Object.fromEntries(names.map((name) => [name, readFileSync(join(dir, name), "utf8")])) };
}

test("S16: sessions that start at the same instant rewrite the same files without errors, leaving the right files and the original backups", async () => {
	for (const sessions of [2, 4]) {
		for (let round = 0; round < 3; round++) {
			const { dir, names, originals } = manyAgentsDir();
			const expectedDir = manyAgentsDir().dir;
			applyCodegraphSubagents(expectedDir);
			const startAt = Date.now() + 800;
			const results = await Promise.all(Array.from({ length: sessions }, () => sessionApplying(dir, startAt)));
			const label = `${sessions} sessions, round ${round}`;
			assert.deepEqual(results.flatMap((result) => result.errors), [], label);
			for (const name of names) {
				assert.equal(readFileSync(join(dir, name), "utf8"), readFileSync(join(expectedDir, name.replace("gentle-ai-verify", "gentle-ai-verify")), "utf8"), `${label}: ${name}`);
				assert.equal(readFileSync(join(dir, name) + ".pre-codegraph-subagents.bak", "utf8"), originals[name], `${label}: backup of ${name}`);
			}
			assert.deepEqual(readdirSync(join(dir, "agents")).filter((entry) => entry.endsWith(".tmp")), [], `${label}: no temp files left`);
		}
	}
});
