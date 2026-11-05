// `npm test` must fail when it finds no tests: `node --test` alone exits 0 on an empty or wrong glob.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-tests.mjs");

/** Runs the runner in a fresh project whose test/ folder holds `files`. */
function runIn(files: Record<string, string>, args: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "pcs-runner-"));
	mkdirSync(join(dir, "test"));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "test", name), body);
	// Inside a test run NODE_TEST_CONTEXT is set, and run() would refuse to start as a nested runner.
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, [RUNNER, ...args], { cwd: dir, env, encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const PASSING = 'import { test } from "node:test";\ntest("passes", () => {});\n';
const FAILING = 'import { test } from "node:test";\ntest("fails", () => { throw new Error("boom"); });\n';

test("the runner fails and says why when no test file matches", () => {
	const run = runIn({});
	assert.equal(run.status, 1, run.output);
	assert.match(run.output, /no tests ran/);
});

test("the runner fails when the matched files hold no test", () => {
	const run = runIn({ "empty.test.ts": "export {};\n" });
	assert.equal(run.status, 1, run.output);
	assert.match(run.output, /no tests ran/);
});

test("the runner passes when every test passes, and shows the test names", () => {
	const run = runIn({ "ok.test.ts": PASSING });
	assert.equal(run.status, 0, run.output);
	assert.match(run.output, /passes/);
	assert.doesNotMatch(run.output, /no tests ran/);
});

test("the runner fails when a test fails, even next to passing ones", () => {
	const run = runIn({ "ok.test.ts": PASSING, "bad.test.ts": FAILING });
	assert.equal(run.status, 1, run.output);
	assert.match(run.output, /boom/);
});

test("the runner fails when a test file cannot even load", () => {
	const run = runIn({ "broken.test.ts": 'import "./missing.ts";\n' });
	assert.equal(run.status, 1, run.output);
});

test("the runner takes other globs as arguments", () => {
	const run = runIn({ "ok.test.ts": PASSING, "bad.test.ts": FAILING }, ["test/ok.test.ts"]);
	assert.equal(run.status, 0, run.output);
	assert.doesNotMatch(run.output, /boom/);
});
