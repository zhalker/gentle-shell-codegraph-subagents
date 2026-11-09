import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSkillReminder, WORKER_MARKER } from "../src/skill-reminder.ts";

const expected = "C:/pkg/skills/codegraph-workflow/SKILL.md";
const skill = { name: "codegraph-workflow", filePath: expected, disableModelInvocation: false };
const base = { expectedPath: expected, skills: [skill], child: false, systemPrompt: "", argv: [], alreadySent: false, isUserPrompt: true };

// gentle-pi passes an agent body over 1000 bytes as a file after --append-system-prompt (lib/agents-runner.ts).
const workerArgv = (dir: string) => ["C:\\Program Files\\node.exe", "pi", "--append-system-prompt", `${dir}${dir.includes("\\") ? "\\" : "/"}instructions.md`, "--tools", "read,bash"];

function reminder(overrides: Partial<Parameters<typeof chooseSkillReminder>[0]>) {
	return chooseSkillReminder({ ...base, ...overrides });
}

test("S3: the parent receives a reminder only on the first user prompt", () => {
	assert.match(chooseSkillReminder(base) ?? "", /codegraph-workflow/);
	assert.equal(chooseSkillReminder({ ...base, alreadySent: true }), undefined);
	assert.equal(chooseSkillReminder({ ...base, isUserPrompt: false }), undefined);
});

test("S3: a worker child receives a reminder while other children do not", () => {
	assert.match(chooseSkillReminder({ ...base, child: true, systemPrompt: WORKER_MARKER }) ?? "", /codegraph-workflow/);
	assert.equal(chooseSkillReminder({ ...base, child: true }), undefined);
});

test("S5: a worker child is detected from the instructions path in its argv, with no marker in its file", () => {
	const windows = workerArgv("C:\\Users\\Tony\\AppData\\Local\\Temp\\gpHCf3HX\\gentle-pi-subagent-gentle-ai-worker-DZgR2G");
	assert.match(chooseSkillReminder({ ...base, child: true, argv: windows }) ?? "", /codegraph-workflow/);
	const posix = workerArgv("/tmp/gpHCf3HX/gentle-pi-subagent-gentle-ai-worker-DZgR2G");
	assert.match(chooseSkillReminder({ ...base, child: true, argv: posix }) ?? "", /codegraph-workflow/);
});

test("S5: a frozen worker file still triggers the reminder through the old marker", () => {
	assert.match(chooseSkillReminder({ ...base, child: true, systemPrompt: `Body.\n${WORKER_MARKER}\n` }) ?? "", /codegraph-workflow/);
});

test("S5: another child, such as the explorer, receives no reminder", () => {
	assert.equal(reminder({ child: true, argv: workerArgv("/tmp/gp/gentle-pi-subagent-gentle-ai-explore-A1b2C3") }), undefined);
	assert.equal(reminder({ child: true, argv: workerArgv("/tmp/gp/gentle-pi-subagent-gentle-ai-verify-A1b2C3") }), undefined);
	// A first argument that is not a path after the flag names no subagent folder.
	assert.equal(reminder({ child: true, argv: ["pi", "--append-system-prompt", "--tools", "read"] }), undefined);
});

test("S2/S3: no reminder points to an unrelated, missing, or disabled skill", () => {
	assert.equal(chooseSkillReminder({ ...base, skills: [{ ...skill, filePath: "C:/user/SKILL.md" }] }), undefined);
	assert.equal(chooseSkillReminder({ ...base, skills: [] }), undefined);
	assert.equal(chooseSkillReminder({ ...base, skills: [{ ...skill, disableModelInvocation: true }] }), undefined);
});
