// The index notice: on the first prompt of a session that has an index and a CodeGraph tool, the extension
// states that the index exists, because a model that checks with find or grep sees nothing (.codegraph/ is
// git-ignored) and then never calls CodeGraph. The same module writes the prefetch log.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chooseIndexNotice,
	codegraphTools,
	findIndexRoot,
	firstPromptMessage,
	INDEX_NOTICE_MARKER,
	INDEX_NOTICE_TYPE,
	indexNotice,
	logPrefetch,
	noticeTools,
} from "../src/index-notice.ts";
import { SKILL_REMINDER_TYPE } from "../src/skill-reminder.ts";
import { adminShareOf } from "./helpers.ts";

const MCP = "mcp__codegraph__codegraph_explore";

function scratchDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "notice-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A project directory holding an index. */
function indexedDir(t: TestContext): string {
	const root = scratchDir(t);
	mkdirSync(join(root, ".codegraph"), { recursive: true });
	writeFileSync(join(root, ".codegraph", "codegraph.db"), "");
	return root;
}

test("S1: the index root is the nearest directory at or above the cwd holding .codegraph/codegraph.db", (t) => {
	const root = indexedDir(t);
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	assert.equal(findIndexRoot(root), root);
	assert.equal(findIndexRoot(join(root, "src")), root);
	assert.equal(findIndexRoot(join(root, "src", "deep")), root);
});

test("S1: a .codegraph folder without a database is not an index, and no index means no root", (t) => {
	const root = indexedDir(t);
	mkdirSync(join(root, "sub", ".codegraph"), { recursive: true });
	assert.equal(findIndexRoot(join(root, "sub")), root, "the walk continues past a folder without the database");
	// The walk stops at the top of the tree instead of looping forever.
	assert.equal(findIndexRoot(join("C:", "definitely", "not", "indexed"), () => false), undefined);
});

test("S1: the CodeGraph tools are the extension tool and the MCP tool; the MCP wildcard counts as the MCP tool", () => {
	assert.deepEqual(codegraphTools(["read", "grep", "find", MCP]), [MCP]);
	assert.deepEqual(codegraphTools(["read", "mcp__codegraph__*"]), [MCP]);
	assert.deepEqual(codegraphTools(["bash", "codegraph"]), ["codegraph"]);
	assert.deepEqual(codegraphTools(["bash", "codegraph", MCP]), ["codegraph", MCP]);
	assert.deepEqual(codegraphTools(["read", "grep", "find", "bash"]), []);
});

test("S1: a child merges the tools gentle-pi requested, because its MCP tools are not selected yet", () => {
	// In a live run the explorer child had no MCP tool in selectedTools at before_agent_start.
	assert.deepEqual(noticeTools(["read", "grep", "find"], ` read, grep , ${MCP},mcp__codegraph__*, `, true), ["read", "grep", "find", MCP, "mcp__codegraph__*"]);
	assert.deepEqual(codegraphTools(noticeTools(["read", "grep", "find"], `read,grep,${MCP}`, true)), [MCP]);
	assert.deepEqual(noticeTools(["read", MCP], `${MCP},codegraph`, true), ["read", MCP, "codegraph"], "no duplicates");
});

test("S1: the main session ignores the child env, and an empty or missing one adds nothing", () => {
	assert.deepEqual(noticeTools(["bash", "codegraph"], MCP, false), ["bash", "codegraph"]);
	assert.deepEqual(noticeTools([], "", true), []);
	assert.deepEqual(noticeTools([], "  , ,\t, ", true), []);
	assert.deepEqual(noticeTools([], undefined, true), []);
});

test("S1: no notice on a non-user prompt, once sent, without a CodeGraph tool or without an index", (t) => {
	const root = indexedDir(t);
	const plain = scratchDir(t);
	const base = { cwd: root, child: true, selectedTools: ["read", MCP], isUserPrompt: true, alreadySent: false };
	assert.ok(chooseIndexNotice(base));
	assert.equal(chooseIndexNotice({ ...base, isUserPrompt: false }), undefined);
	assert.equal(chooseIndexNotice({ ...base, alreadySent: true }), undefined);
	assert.equal(chooseIndexNotice({ ...base, selectedTools: ["read", "grep", "find"] }), undefined);
	assert.equal(chooseIndexNotice({ ...base, cwd: plain }), undefined);
});

test("S1: an explorer child gets a notice that names its MCP tool and forbids checking with find/grep/ls", (t) => {
	const root = indexedDir(t);
	const notice = chooseIndexNotice({ cwd: join(root, "src"), child: true, selectedTools: ["read", "grep", "find", "mcp__codegraph__*", MCP], isUserPrompt: true, alreadySent: false });
	assert.ok(notice);
	assert.ok(notice.startsWith(INDEX_NOTICE_MARKER), "the marker is where the extension looks for it");
	assert.ok(notice.includes(root), "the model gets the real directory");
	assert.match(notice, /HAS a CodeGraph index/);
	assert.match(notice, /`mcp__codegraph__codegraph_explore`/);
	assert.match(notice, /do not use find, grep or ls to check/i);
	assert.match(notice, /git-ignored/);
	assert.doesNotMatch(notice, /`codegraph` tool/, "the explorer does not hold the extension tool");
});

test("S1: the main session gets a notice naming both CodeGraph tools it holds", (t) => {
	const root = indexedDir(t);
	const notice = chooseIndexNotice({ cwd: root, child: false, selectedTools: ["bash", "codegraph", MCP], isUserPrompt: true, alreadySent: false });
	assert.ok(notice);
	assert.match(notice, /`codegraph` tool/);
	assert.match(notice, /`mcp__codegraph__codegraph_explore`/);
	assert.match(notice, /changed on disk after the last index sync/);
});

test("S1: the notice asks for the tools first and says how to search when CodeGraph is not enough", () => {
	const notice = indexNotice("C:\\project", ["codegraph"]);
	assert.match(notice, /call the `codegraph` tool .* FIRST, before grep, find or broad reads/);
	assert.match(notice, /do not use find, grep or ls to check/i);
	assert.match(notice, /grep for string literals/);
});

test("S1: one log line per prefetch, tab separated: ISO time, outcome, Nms, cwd", (t) => {
	const dir = join(scratchDir(t), "nested", "codegraph-subagents");
	logPrefetch({ cwd: "C:\\project", outcome: "daemon-timeout", ms: 60_001 }, dir);
	logPrefetch({ cwd: "\\\\server\\share", outcome: "skipped-init-running", ms: 3 }, dir);
	const lines = readFileSync(join(dir, "prefetch.log"), "utf8").split("\n");
	assert.equal(lines.length, 3, "each call appends one line; the file ends in a newline");
	assert.deepEqual(lines.slice(0, 2).map((line) => line.split("\t").length), [4, 4]);
	const [time, outcome, ms, cwd] = lines[0].split("\t");
	assert.match(time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "an ISO timestamp");
	assert.ok(!Number.isNaN(Date.parse(time)));
	assert.equal(outcome, "daemon-timeout");
	assert.equal(ms, "60001ms");
	assert.equal(cwd, "C:\\project");
	assert.match(lines[1], /^[^\t]+\tskipped-init-running\t3ms\t\\\\server\\share$/);
});

test("S1: a directory name with tabs or line breaks stays inside its own line and field", (t) => {
	const dir = scratchDir(t);
	logPrefetch({ cwd: "/srv/a\tb\nc\r\nd\u0000e", outcome: "ok", ms: 1 }, dir);
	logPrefetch({ cwd: "/srv/x\n2026-01-01T00:00:00.000Z\tok\t1ms\t/forged", outcome: "empty", ms: 2 }, dir);
	const lines = readFileSync(join(dir, "prefetch.log"), "utf8").split("\n");
	assert.equal(lines.length, 3, "two calls, two lines");
	assert.deepEqual(lines.slice(0, 2).map((line) => line.split("\t").length), [4, 4]);
	assert.equal(lines[0].split("\t")[3], "/srv/a?b?c??d?e");
	assert.equal(lines[1].split("\t")[1], "empty");
	assert.equal(lines[1].split("\t")[3], "/srv/x?2026-01-01T00:00:00.000Z?ok?1ms?/forged");
});

test("S1: logging never breaks a prompt, even when the log directory cannot be created", (t) => {
	const file = join(scratchDir(t), "not-a-directory");
	writeFileSync(file, "keep");
	assert.doesNotThrow(() => logPrefetch({ cwd: "C:\\project", outcome: "ok", ms: 1 }, file));
	assert.doesNotThrow(() => logPrefetch({ cwd: "C:\\project", outcome: "ok", ms: 1 }, join(file, "nested")));
	assert.equal(readFileSync(file, "utf8"), "keep");
});

test("S1: the first prompt carries the notice, the skill reminder and the prefetch as one message", () => {
	const notice = `${INDEX_NOTICE_MARKER} this workspace has an index`;
	const reminder = "For applicable code tasks, read and follow the codegraph-workflow skill.";
	const prefetch = "CodeGraph pre-fetch for your task";
	const joined = `${notice}\n\n${reminder}\n\n${prefetch}`;

	assert.equal(firstPromptMessage({ child: false }), undefined, "nothing to say");
	assert.equal(firstPromptMessage({ child: false, notice: "", reminder: "", prefetch: undefined }), undefined, "empty parts say nothing");
	assert.deepEqual(firstPromptMessage({ child: false, notice }), { customType: INDEX_NOTICE_TYPE, content: notice, display: true });
	assert.deepEqual(firstPromptMessage({ child: true, notice }), { customType: INDEX_NOTICE_TYPE, content: notice, display: false }, "children keep it hidden");
	assert.deepEqual(firstPromptMessage({ child: false, reminder }), { customType: SKILL_REMINDER_TYPE, content: reminder, display: false });
	assert.deepEqual(firstPromptMessage({ child: false, prefetch }), { customType: "codegraph-prefetch", content: prefetch, display: false });
	assert.deepEqual(firstPromptMessage({ child: true, reminder, prefetch }), { customType: SKILL_REMINDER_TYPE, content: `${reminder}\n\n${prefetch}`, display: false });
	assert.deepEqual(firstPromptMessage({ child: false, notice, reminder, prefetch }), { customType: SKILL_REMINDER_TYPE, content: joined, display: true });
	assert.deepEqual(firstPromptMessage({ child: true, notice, reminder, prefetch }), { customType: SKILL_REMINDER_TYPE, content: joined, display: false });
	assert.deepEqual(firstPromptMessage({ child: false, notice, prefetch }), { customType: INDEX_NOTICE_TYPE, content: `${notice}\n\n${prefetch}`, display: true });
});

test("S4: a cwd spelled as the administrative share finds the index of the same project", (t) => {
	const root = indexedDir(t);
	mkdirSync(join(root, "src"), { recursive: true });
	const cwd = adminShareOf(join(root, "src"));
	const expected = adminShareOf(root);
	if (cwd === undefined || expected === undefined) {
		t.skip("the administrative share of this machine is not reachable");
		return;
	}
	assert.equal(findIndexRoot(cwd), expected);
	assert.ok(chooseIndexNotice({ cwd, child: false, selectedTools: ["codegraph"], isUserPrompt: true, alreadySent: false }));
});
