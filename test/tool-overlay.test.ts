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
	// GENTLE_PI_CONFIG_HOME is honored verbatim, relative included, exactly like gentle-pi's own
	// resolution (gentle-shell-bundled.ts: "if (env.GENTLE_PI_CONFIG_HOME) return ..."); only the
	// launcher marker (GENTLE_SHELL_CONFIG_HOME) is gated to absolute values. Writing the drop-in
	// where gentle-pi does not read it would leave the tool silently outside every allowlist.
	assert.equal(resolveConfigHome({ home, env: { GENTLE_PI_CONFIG_HOME: "rel/cfg" } }), "rel/cfg");
	// GENTLE_SHELL_CONFIG_HOME beats home — but not the bundled prefix; absolute only.
	const explicitShell = join(home, "cfg-shell");
	assert.equal(resolveConfigHome({ home, env: { GENTLE_SHELL_CONFIG_HOME: explicitShell }, prefix }), bundled);
	// GENTLE_PI_CONFIG_HOME beats GENTLE_SHELL_CONFIG_HOME (gentle-pi checks them in that order).
	assert.equal(resolveConfigHome({ home, env: { GENTLE_PI_CONFIG_HOME: join(home, "cfg-pi"), GENTLE_SHELL_CONFIG_HOME: explicitShell } }), join(home, "cfg-pi"));
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

test("S2: applyToolOverlays preserves unrelated drop-ins byte for byte and replaces stale copies of our own file", () => {
	const configHome = scratch();
	const dir = join(configHome, OVERLAY_DROPPIN_DIR);
	mkdirSync(dir, { recursive: true });
	const other = join(dir, "other-package.json");
	writeFileSync(other, `{"some-agent": {"add": ["read"]}}`);
	const stashed = readFileSync(other, "utf8");
	// A stale old copy of ours (from an earlier package version) is overwritten with the current content.
	const stale = join(dir, CODEGRAPH_DROPPIN);
	writeFileSync(stale, `{"some-agent": {"add": ["stale"]}}`);
	applyToolOverlays({ configHome });
	assert.equal(existsSync(other), true);
	assert.equal(readFileSync(other, "utf8"), stashed);
	const ours = readJson(stale) as Record<string, { add: string[]; remove: string[] }>;
	assert.deepEqual(Object.keys(ours).sort(), [...SIX].sort());
	for (const agent of SIX) assert.deepEqual(ours[agent], { add: [TOOL_TO_ADD], remove: [] });
});

test("S2: applyToolOverlays tolerates a config home that does not exist yet", () => {
	const configHome = join(scratch(), "nested", "deeper");
	const result = applyToolOverlays({ configHome });
	assert.equal(existsSync(join(configHome, OVERLAY_DROPPIN_DIR, CODEGRAPH_DROPPIN)), true);
	assert.deepEqual(result.errors, []);
});
