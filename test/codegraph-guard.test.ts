// Rules in a user's AGENTS.md can make the model rebuild the CodeGraph index before every search, which stops the
// daemon this package keeps warm. The guard blocks that rebuild and says what to do instead.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as guard from "../src/codegraph-guard.ts";
import { ALLOW_ENV, guardIndexCommand } from "../src/codegraph-guard.ts";
import { prefetchForExplorer } from "../src/prefetch.ts";

function scratch(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pcs-guard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function indexed(dir: string): string {
	mkdirSync(join(dir, ".codegraph"), { recursive: true });
	writeFileSync(join(dir, ".codegraph", "codegraph.db"), "");
	return dir;
}

test("S1: codegraph index in a project that has an index is blocked, with the reason, what to do instead and the escape hatch", (t) => {
	const root = indexed(scratch(t));
	const reason = guardIndexCommand({ command: "codegraph index", cwd: root });
	assert.ok(reason, "blocked");
	assert.match(reason, /already has a CodeGraph index/);
	assert.ok(reason.includes(root), "names the index root");
	assert.match(reason, /stops the running daemon/);
	assert.match(reason, /codegraph sync/);
	assert.ok(reason.includes(`${ALLOW_ENV}=1 codegraph index`), "names the escape hatch");
	assert.equal(ALLOW_ENV, "CODEGRAPH_SUBAGENTS_ALLOW");
});

test("S1: every way of starting it is caught, from a subfolder of the project too", (t) => {
	const root = indexed(scratch(t));
	mkdirSync(join(root, "src"));
	for (const command of [
		"codegraph index",
		"codegraph index .",
		"codegraph index -v",
		"npx codegraph index",
		"npx -y codegraph index",
		"codegraph.cmd index",
		"cd src && codegraph index",
		"git pull; codegraph index",
		"echo start\ncodegraph index",
		"FOO=1 codegraph index",
	]) {
		assert.ok(guardIndexCommand({ command, cwd: root }), `blocked: ${JSON.stringify(command)}`);
	}
	assert.ok(guardIndexCommand({ command: "codegraph index", cwd: join(root, "src") }), "a subfolder belongs to the indexed project");
});

test("S1: a path given to index decides which project it rebuilds", (t) => {
	const root = indexed(scratch(t));
	const other = scratch(t);
	assert.equal(guardIndexCommand({ command: `codegraph index "${other}"`, cwd: root }), undefined, "the other project has no index yet");
	assert.ok(guardIndexCommand({ command: `codegraph index "${root}"`, cwd: other }), "the named project has one");
});

test("S1: init, sync, other projects and text that only mentions the command are left alone", (t) => {
	const root = indexed(scratch(t));
	const empty = scratch(t);
	for (const command of [
		"codegraph sync",
		"codegraph sync -q",
		"codegraph init -y",
		"codegraph status",
		"codegraph explore index",
		'grep -n "codegraph index" AGENTS.md',
		"echo codegraph index",
		"git log --grep codegraph",
	]) {
		assert.equal(guardIndexCommand({ command, cwd: root }), undefined, `allowed: ${JSON.stringify(command)}`);
	}
	assert.equal(guardIndexCommand({ command: "codegraph index", cwd: empty }), undefined, "no index yet: building one is fine");
});

test("S2: the escape hatch lets a deliberate rebuild through", (t) => {
	const root = indexed(scratch(t));
	assert.equal(guardIndexCommand({ command: `${ALLOW_ENV}=1 codegraph index`, cwd: root }), undefined);
	assert.equal(guardIndexCommand({ command: `export ${ALLOW_ENV}=1 && codegraph index`, cwd: root }), undefined);
	assert.ok(guardIndexCommand({ command: `${ALLOW_ENV}=0 codegraph index`, cwd: root }), "only =1 opens it");
});

test("S5: the pre-fetch header says the daemon answered, not that codegraph explore ran", async () => {
	const text = await prefetchForExplorer({
		env: { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_REQUESTED_TOOLS: "read,mcp__codegraph__codegraph_explore" },
		prompt: "map how session discovery works",
		cwd: "C:\\project",
		exists: () => true,
		explore: async () => "TEXT",
	});
	assert.match(String(text), /^CodeGraph pre-fetch for your task/);
	assert.match(String(text), /daemon/);
	assert.doesNotMatch(String(text), /codegraph explore`/);
});

test("S3: the guard only blocks commands; it no longer detects rules, warns about conflicts or keeps notice state", () => {
	assert.deepEqual(Object.keys(guard).sort(), ["ALLOW_ENV", "findIndexRoot", "guardIndexCommand"]);
});
