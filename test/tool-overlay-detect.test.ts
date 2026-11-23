import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGentlePiVersion, shouldUseOverlay } from "../src/tool-overlay.ts";

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pcs-overdet-")));
}

test("S2: shouldUseOverlay is true exactly for gentle-pi >= 4.9.0", () => {
	assert.equal(shouldUseOverlay("4.9.0"), true);
	assert.equal(shouldUseOverlay("4.10.0"), true);
	assert.equal(shouldUseOverlay("5.0.0"), true);
	assert.equal(shouldUseOverlay("4.8.0"), false);
	assert.equal(shouldUseOverlay("4.9.0-beta.1"), false);
	assert.equal(shouldUseOverlay(undefined), false);
	assert.equal(shouldUseOverlay("garbage"), false);
});

test("S2: findGentlePiVersion reads the installed package version, or undefined when absent/invalid", () => {
	const agentDir = scratch();
	assert.equal(findGentlePiVersion(agentDir), undefined);
	const pkg = join(agentDir, "npm", "node_modules", "gentle-pi", "package.json");
	// The real tree is pnpm-shaped: nested node_modules. Keep it simple: direct path first.
	mkdirSync(join(agentDir, "npm", "node_modules", "gentle-pi"), { recursive: true });
	writeFileSync(pkg, JSON.stringify({ version: "4.9.0" }));
	assert.equal(findGentlePiVersion(agentDir), "4.9.0");
	writeFileSync(pkg, "not json");
	assert.equal(findGentlePiVersion(agentDir), undefined);
});
