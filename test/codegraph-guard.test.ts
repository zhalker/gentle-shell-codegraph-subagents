// Rules in a user's AGENTS.md can make the model rebuild the CodeGraph index before every search, which stops the
// daemon this package keeps warm. The guard blocks that rebuild, and the user is told once per project.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW_ENV, conflictWarning, findRuleConflicts, guardIndexCommand, takeConflictNotice } from "../src/codegraph-guard.ts";
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

// The rule a user had in a global AGENTS.md, verbatim.
const USER_RULE = 'Codegraph comes first: for every refactor, code fix, analysis or investigation, run a codegraph query or explore BEFORE any fd/find/rg/grep symbol search whenever the workspace has a .codegraph index; if no .codegraph folder exists, initialize the project by running "codegraph init" and "codegraph index" first, then query; ALWAYS refresh the index by running "codegraph sync" before any use or call to codegraph so searches run against the most updated data; fd/find/rg/grep only after codegraph, for exact-string or filename lookups, or when codegraph fails or the index could not be initialized. This includes subagents and worktrees: codegraph is workspace-scoped, in a worktree run operation init before the first query there, and when a subagent cannot call codegraph, the parent session runs the query and passes the findings in the task handoff';

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

test("S3: the user's rule conflicts on index and on sync; a negated or occasional rule does not", () => {
	assert.deepEqual(findRuleConflicts([{ path: "/home/u/.pi/agent/AGENTS.md", content: USER_RULE }]), [
		{ path: "/home/u/.pi/agent/AGENTS.md", commands: ["index", "sync"] },
	]);
	assert.deepEqual(findRuleConflicts([
		{ path: "a/AGENTS.md", content: "- Do not run `codegraph index` before every query.\n- Never run codegraph sync before each search." },
		{ path: "b/AGENTS.md", content: "Run `codegraph sync` after a git pull or a branch switch." },
		{ path: "c/AGENTS.md", content: "Look things up in the .codegraph folder first. Then grep." },
		{ path: "d/CLAUDE.md", content: "Always run `codegraph init` before you start.\nRun codegraph sync every time you search." },
	]), [{ path: "d/CLAUDE.md", commands: ["init", "sync"] }]);
	assert.deepEqual(findRuleConflicts([]), []);
});

test("S3: the warning names the file, the reasons and the consequences, and says it shows once", () => {
	const message = conflictWarning([{ path: "/home/u/.pi/agent/AGENTS.md", commands: ["index", "sync"] }]);
	assert.ok(message.includes("/home/u/.pi/agent/AGENTS.md"));
	assert.match(message, /codegraph index/);
	assert.match(message, /codegraph sync/);
	assert.match(message, /already creates and syncs the index/);
	assert.match(message, /stops the daemon/);
	assert.match(message, /slower/);
	assert.match(message, /once per project/);
});

test("S4: the warning is taken once per project, survives a restart, and a damaged record does not break it", (t) => {
	const state = join(scratch(t), "state");
	const conflicts = [{ path: "AGENTS.md", commands: ["sync" as const] }];
	const first = takeConflictNotice({ root: "C:\\work\\one", conflicts, stateDir: state });
	assert.ok(first);
	assert.equal(takeConflictNotice({ root: "C:\\work\\one", conflicts, stateDir: state }), undefined, "same project");
	assert.equal(takeConflictNotice({ root: "C:\\work\\one", conflicts: [{ path: "OTHER.md", commands: ["index" as const] }], stateDir: state }), undefined, "edited files do not bring it back");
	assert.ok(takeConflictNotice({ root: "C:\\work\\two", conflicts, stateDir: state }), "another project");
	const record = readFileSync(join(state, "conflict-notices.json"), "utf8");
	assert.ok(!record.includes("AGENTS.md"), "only projects are recorded, never file names or contents");
	writeFileSync(join(state, "conflict-notices.json"), "{ damaged");
	assert.ok(takeConflictNotice({ root: "C:\\work\\three", conflicts, stateDir: state }), "a damaged record is read as empty");
	assert.equal(takeConflictNotice({ root: "C:\\work\\three", conflicts, stateDir: state }), undefined);
});

test("S4: nothing to warn about records nothing, and a state directory that cannot be written still warns without throwing", (t) => {
	const dir = scratch(t);
	assert.equal(takeConflictNotice({ root: "C:\\work\\one", conflicts: [], stateDir: join(dir, "state") }), undefined);
	assert.equal(existsSync(join(dir, "state", "conflict-notices.json")), false);
	const file = join(dir, "not-a-directory");
	writeFileSync(file, "keep");
	assert.doesNotThrow(() => takeConflictNotice({ root: "C:\\work\\one", conflicts: [{ path: "AGENTS.md", commands: ["sync"] }], stateDir: file }));
	assert.equal(readFileSync(file, "utf8"), "keep");
});
