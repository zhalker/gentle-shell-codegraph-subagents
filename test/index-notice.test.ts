// The index lifecycle: where the index is, what preparing it is doing, and what an observed native
// `codegraph init` gets appended. The first-prompt notice is gone: the fact that an index exists rides the
// CodeGraph rule (`src/codegraph-rules.ts`), inside the section the model already receives.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codegraphTools } from "../src/agents.ts";
import {
	findIndexRoot,
	noticeTools,
	indexOutcomeNotice,
	indexStartNotice,
	warmOutcomeNotice,
} from "../src/index-notice.ts";
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
});

test("S5: the index fact is no longer a separate first-prompt notice", async () => {
	const module = await import("../src/index-notice.ts");
	for (const gone of ["INDEX_NOTICE_MARKER", "INDEX_NOTICE_TYPE", "chooseIndexNotice", "indexNotice", "firstPromptMessage"]) {
		assert.equal(gone in module, false, `${gone} must not survive: the section carries the fact now`);
	}
});

// --- S2/S6: the notices name the action really taken, and never present a pending or failed write as synced ---

test("S2: the start of each action names that action, so create-or-sync is visible while it happens", () => {
	assert.match(indexStartNotice("init"), /creating the CodeGraph index/);
	assert.match(indexStartNotice("seed"), /seeding this worktree's CodeGraph index/);
	assert.match(indexStartNotice("sync"), /syncing the CodeGraph index/);
	assert.deepEqual([indexStartNotice("init"), indexStartNotice("seed"), indexStartNotice("sync")].length, 3);
});

test("S2: only a run that came back is reported as synced, created or seeded", () => {
	assert.deepEqual(indexOutcomeNotice({ action: "sync", ok: true }, "C:\\p"), { text: "CodeGraph index synced", level: "info" });
	assert.deepEqual(indexOutcomeNotice({ action: "init", ok: true }, "C:\\p"), { text: "CodeGraph index created", level: "info" });
	assert.deepEqual(indexOutcomeNotice({ action: "seed", ok: true }, "C:\\p"), { text: "CodeGraph index seeded from the main repo and synced", level: "info" });
});

test("S2/S6: a queued, joined or coalesced request is never presented as a sync of this session", () => {
	const queued = indexOutcomeNotice({ action: "sync", ok: true, queued: true }, "C:\\p");
	assert.match(queued.text, /queued, not run yet/);
	assert.doesNotMatch(queued.text, /synced/i);

	const coalesced = indexOutcomeNotice({ action: "sync", ok: true, coalesced: true }, "C:\\p");
	assert.match(coalesced.text, /another session's run completed/);
	assert.doesNotMatch(coalesced.text, /^CodeGraph index synced$/);

	const joinedInit = indexOutcomeNotice({ action: "init", ok: true, joined: true }, "C:\\p");
	assert.match(joinedInit.text, /another session is creating the CodeGraph index/);
	const joinedSync = indexOutcomeNotice({ action: "sync", ok: true, joined: true }, "C:\\p");
	assert.match(joinedSync.text, /this session did not sync it/);
	assert.doesNotMatch(joinedSync.text, /^CodeGraph index synced$/);
});

test("S6: unusable coordination is a warning that says no sync was started, not a synced index", () => {
	const notice = indexOutcomeNotice({ action: "sync", ok: false, unavailable: true }, "C:\\p");
	assert.deepEqual(notice, { text: "could not coordinate the CodeGraph index sync in C:\\p; no sync was started", level: "warning" });
});

test("S6: a failed command is a warning naming the action, and never says the index is up to date", () => {
	for (const action of ["sync", "init", "seed"] as const) {
		const notice = indexOutcomeNotice({ action, ok: false }, "C:\\p");
		assert.equal(notice.level, "warning");
		assert.match(notice.text, new RegExp(`codegraph ${action} failed in C:\\\\p`));
		assert.match(notice.text, /the index is not up to date/);
	}
});

test("S6: the warm-up outcome is reported apart from the index's", () => {
	assert.deepEqual(warmOutcomeNotice("ok", "C:\\p"), { text: "CodeGraph ready", level: "info" });
	assert.deepEqual(warmOutcomeNotice("failed", "C:\\p"), { text: "CodeGraph warm-up failed in C:\\p", level: "warning" });
});
