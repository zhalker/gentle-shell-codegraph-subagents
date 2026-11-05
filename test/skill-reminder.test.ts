import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSkillReminder, WORKER_MARKER } from "../src/skill-reminder.ts";

const expected = "C:/pkg/skills/codegraph-workflow/SKILL.md";
const skill = { name: "codegraph-workflow", filePath: expected, disableModelInvocation: false };
const base = { expectedPath: expected, skills: [skill], child: false, systemPrompt: "", alreadySent: false, isUserPrompt: true };

test("S3: the parent receives a reminder only on the first user prompt", () => {
	assert.match(chooseSkillReminder(base) ?? "", /codegraph-workflow/);
	assert.equal(chooseSkillReminder({ ...base, alreadySent: true }), undefined);
	assert.equal(chooseSkillReminder({ ...base, isUserPrompt: false }), undefined);
});

test("S3: a worker child receives a reminder while other children do not", () => {
	assert.match(chooseSkillReminder({ ...base, child: true, systemPrompt: WORKER_MARKER }) ?? "", /codegraph-workflow/);
	assert.equal(chooseSkillReminder({ ...base, child: true }), undefined);
});

test("S2/S3: no reminder points to an unrelated, missing, or disabled skill", () => {
	assert.equal(chooseSkillReminder({ ...base, skills: [{ ...skill, filePath: "C:/user/SKILL.md" }] }), undefined);
	assert.equal(chooseSkillReminder({ ...base, skills: [] }), undefined);
	assert.equal(chooseSkillReminder({ ...base, skills: [{ ...skill, disableModelInvocation: true }] }), undefined);
});
