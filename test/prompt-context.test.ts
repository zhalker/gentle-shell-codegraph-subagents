// What the model still sees after a compaction, so the index notice and the skill reminder come back once on the
// next user prompt, and how the first-prompt message is drawn in the transcript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstPromptMessage, INDEX_NOTICE_MARKER, INDEX_NOTICE_TYPE } from "../src/index-notice.ts";
import { contextEntries, promptContext, promptMessageLine } from "../src/prompt-context.ts";
import { SKILL_REMINDER_TYPE } from "../src/skill-reminder.ts";

const NOTICE = `${INDEX_NOTICE_MARKER} This workspace HAS a CodeGraph index at C:\\project.`;
const REMINDER = "For applicable code tasks, read and follow the codegraph-workflow skill at C:\\skills\\codegraph-workflow\\SKILL.md.";
const PREFETCH = "CodeGraph pre-fetch for your task, answered by this project's CodeGraph daemon before your first step (bounded in size and time).";

const user = (id: string) => ({ type: "message", id });
const sent = (id: string, customType: string, content: string) => ({ type: "custom_message", id, customType, content, display: true });
const compaction = (id: string, firstKeptEntryId: string) => ({ type: "compaction", id, firstKeptEntryId, summary: "summary" });
const ids = (entries: { id: string }[]) => entries.map((entry) => entry.id);

test("S1: without a compaction the model sees the whole branch, and a sent notice and reminder count as present", () => {
	const branch = [user("u1"), sent("m1", SKILL_REMINDER_TYPE, `${NOTICE}\n\n${REMINDER}`), user("u2")];
	assert.deepEqual(ids(contextEntries(branch)), ["u1", "m1", "u2"]);
	assert.deepEqual(promptContext(branch), { noticeInContext: true, reminderInContext: true, afterCompaction: false });
	assert.deepEqual(promptContext([]), { noticeInContext: false, reminderInContext: false, afterCompaction: false });
	assert.deepEqual(promptContext([user("u1"), sent("m1", INDEX_NOTICE_TYPE, NOTICE)]), { noticeInContext: true, reminderInContext: false, afterCompaction: false });
});

test("S1: a notice and reminder summarized away by a compaction are no longer present, so the next prompt sends them again", () => {
	const branch = [user("u1"), sent("m1", SKILL_REMINDER_TYPE, `${NOTICE}\n\n${REMINDER}`), user("u2"), user("u3"), compaction("c1", "u3")];
	assert.deepEqual(ids(contextEntries(branch)), ["u3", "c1"]);
	assert.deepEqual(promptContext(branch), { noticeInContext: false, reminderInContext: false, afterCompaction: true });
});

test("S1: once sent again after the compaction, or when kept by it, they count as present and are not repeated", () => {
	const resent = [user("u1"), sent("m1", INDEX_NOTICE_TYPE, NOTICE), user("u2"), compaction("c1", "u2"), user("u3"), sent("m2", SKILL_REMINDER_TYPE, `${NOTICE}\n\n${REMINDER}`)];
	assert.deepEqual(promptContext(resent), { noticeInContext: true, reminderInContext: true, afterCompaction: true });
	const kept = [user("u1"), sent("m1", SKILL_REMINDER_TYPE, `${NOTICE}\n\n${REMINDER}`), user("u2"), compaction("c1", "u1")];
	assert.deepEqual(ids(contextEntries(kept)), ["u1", "m1", "u2", "c1"]);
	assert.deepEqual(promptContext(kept), { noticeInContext: true, reminderInContext: true, afterCompaction: true });
});

test("S1: with several compactions only the last one decides what the model sees", () => {
	const branch = [
		user("u1"), sent("m1", INDEX_NOTICE_TYPE, NOTICE), user("u2"), compaction("c1", "u1"),
		user("u3"), user("u4"), compaction("c2", "u4"), user("u5"),
	];
	assert.deepEqual(ids(contextEntries(branch)), ["u4", "c2", "u5"]);
	assert.equal(promptContext(branch).noticeInContext, false);
});

test("S1: a kept entry that is not on the branch, or a compaction that keeps nothing, leaves only what follows the compaction", () => {
	const lost = [user("u1"), sent("m1", INDEX_NOTICE_TYPE, NOTICE), compaction("c1", "elsewhere"), user("u2")];
	assert.deepEqual(ids(contextEntries(lost)), ["c1", "u2"]);
	assert.equal(promptContext(lost).noticeInContext, false);
	const none = [user("u1"), sent("m1", INDEX_NOTICE_TYPE, NOTICE), compaction("c1", "c1"), user("u2")];
	assert.deepEqual(ids(contextEntries(none)), ["c1", "u2"]);
	assert.equal(promptContext(none).noticeInContext, false);
});

test("S1: a custom message of another extension, or the marker inside a user message, is not the notice", () => {
	const branch = [{ type: "message", id: "u1", content: NOTICE }, sent("m1", "other-extension", REMINDER)];
	assert.deepEqual(promptContext(branch), { noticeInContext: false, reminderInContext: false, afterCompaction: false });
});

test("S3: a message sent after a compaction is never displayed; the first one keeps the display rule it had", () => {
	assert.deepEqual(firstPromptMessage({ child: false, notice: NOTICE, reminder: REMINDER, afterCompaction: true }), { customType: SKILL_REMINDER_TYPE, content: `${NOTICE}\n\n${REMINDER}`, display: false });
	assert.deepEqual(firstPromptMessage({ child: false, notice: NOTICE, afterCompaction: true }), { customType: INDEX_NOTICE_TYPE, content: NOTICE, display: false });
	assert.deepEqual(firstPromptMessage({ child: false, notice: NOTICE, afterCompaction: false }), { customType: INDEX_NOTICE_TYPE, content: NOTICE, display: true });
	assert.deepEqual(firstPromptMessage({ child: false, notice: NOTICE }), { customType: INDEX_NOTICE_TYPE, content: NOTICE, display: true });
});

test("S2: collapsed, the first-prompt message is one short line naming what was added and how to expand it", () => {
	const hint = "ctrl+o to expand";
	assert.equal(promptMessageLine(`${NOTICE}\n\n${REMINDER}`, false, hint), "CodeGraph: index notice and skill reminder added to the model's context (ctrl+o to expand)");
	assert.equal(promptMessageLine(NOTICE, false, hint), "CodeGraph: index notice added to the model's context (ctrl+o to expand)");
	assert.equal(promptMessageLine(`${NOTICE}\n\n${REMINDER}\n\n${PREFETCH}`, false, hint), "CodeGraph: index notice, skill reminder and pre-fetch added to the model's context (ctrl+o to expand)");
	assert.ok(!promptMessageLine(`${NOTICE}\n\n${REMINDER}`, false, hint).includes("\n"), "one line");
});

test("S2: expanded, it shows exactly the text the model received", () => {
	const content = `${NOTICE}\n\n${REMINDER}`;
	assert.equal(promptMessageLine(content, true, "ctrl+o to collapse"), content);
});
