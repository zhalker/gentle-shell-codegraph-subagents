import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyToolOverlays,
	CODEGRAPH_DROPPIN,
	OVERLAY_DROPPIN_DIR,
	resolveConfigHome,
	TOOL_TO_ADD,
} from "../src/tool-overlay.ts";

const SIX = ["gentle-ai-explore", "gentle-ai-verify", "gentle-ai-worker", "jd-fix-agent", "jd-judge-a", "jd-judge-b"];

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pcs-overlay-")));
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("S2: resolveConfigHome follows gentle-pi precedence: bundled prefix, GENTLE_PI_CONFIG_HOME, GENTLE_SHELL_CONFIG_HOME, ~/.pi/gentle-ai", () => {
	const home = scratch();
	const prefix = join(home, "prefix");
	const bundled = join(prefix, "config", "gentle-ai");
	mkdirSync(bundled, { recursive: true });
	// Bundled prefix wins, including over GENTLE_PI_CONFIG_HOME (resolveGentlePiConfigHome checks bundled first).
	assert.equal(resolveConfigHome({ home, env: {}, prefix }), bundled);
	assert.equal(resolveConfigHome({ home, env: { GENTLE_PI_CONFIG_HOME: join(home, "cfg-pi") }, prefix }), bundled);
	// GENTLE_SHELL_CONFIG_HOME beats home — but not the bundled prefix; absolute only.
	const explicitShell = join(home, "cfg-shell");
	assert.equal(resolveConfigHome({ home, env: { GENTLE_SHELL_CONFIG_HOME: explicitShell }, prefix }), bundled);
	assert.equal(resolveConfigHome({ home, env: { GENTLE_SHELL_CONFIG_HOME: explicitShell } }), explicitShell);
	assert.equal(resolveConfigHome({ home, env: { GENTLE_SHELL_CONFIG_HOME: "relative/path" } }), join(home, ".pi", "gentle-ai"));
	// Without prefix or env, the home default.
	assert.equal(resolveConfigHome({ home, env: {}, prefix: undefined }), join(home, ".pi", "gentle-ai"));
});

test("S2: applyToolOverlays writes exactly one drop-in JSON adding the CodeGraph tool to the six agents", () => {
	const configHome = scratch();
	const result = applyToolOverlays({ configHome });
	assert.deepEqual(result.changed, [join(configHome, OVERLAY_DROPPIN_DIR, CODEGRAPH_DROPPIN)]);
	const parsed = readJson(join(configHome, OVERLAY_DROPPIN_DIR, CODEGRAPH_DROPPIN)) as Record<string, { add: string[]; remove: string[] }>;
	assert.deepEqual(Object.keys(parsed).sort(), [...SIX].sort());
	for (const agent of SIX) assert.deepEqual(parsed[agent], { add: [TOOL_TO_ADD], remove: [] });
});

test("S2: applyToolOverlays is idempotent: rewriting an identical file changes nothing", () => {
	const configHome = scratch();
	applyToolOverlays({ configHome });
	const result = applyToolOverlays({ configHome });
	assert.deepEqual(result.changed, []);
});

test("S2: applyToolOverlays preserves unrelated drop-ins and replaces only our own file", () => {
	const configHome = scratch();
	const dir = join(configHome, OVERLAY_DROPPIN_DIR);
	mkdirSync(dir, { recursive: true });
	const other = join(dir, "other-package.json");
	writeFileSync(other, `{"some-agent": {"add": ["read"]}}`);
	const stashed = readFileSync(other, "utf8");
	applyToolOverlays({ configHome });
	assert.equal(existsSync(other), true);
	// A stale old copy of ours is overwritten with the current content.
	assert.deepEqual(Object.keys(readJson(join(dir, CODEGRAPH_DROPPIN)) as object).sort(), [...SIX].sort());
});

test("S2: applyToolOverlays tolerates a config home that does not exist yet", () => {
	const configHome = join(scratch(), "nested", "deeper");
	const result = applyToolOverlays({ configHome });
	assert.equal(existsSync(join(configHome, OVERLAY_DROPPIN_DIR, CODEGRAPH_DROPPIN)), true);
	assert.deepEqual(result.errors, []);
});
