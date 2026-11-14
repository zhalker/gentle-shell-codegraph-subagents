// S1: the package ships no skill and sends no skill reminder. The rule that replaced it is the system-prompt
// section in `src/codegraph-rules.ts`, so there is no skill to discover, select or remind the model about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

test("S1: the package declares and ships no skill", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(manifest.files.includes("skills"), false, "npm does not include a skill folder");
	assert.equal(manifest.pi.skills, undefined, "Pi discovers no skill from this package");
	assert.equal(existsSync(join(root, "skills")), false, "the packaged skill is gone");
	assert.equal(existsSync(join(root, "skills", "codegraph-workflow", "SKILL.md")), false);
});

test("S1: the skill reminder module is gone with it", async () => {
	await assert.rejects(import("../src/skill-reminder.ts"), (error: { code?: string }) => error.code === "ERR_MODULE_NOT_FOUND");
});

test("S1: no skill reminder or renderer survives in the extension", () => {
	const text = readFileSync(join(root, "extensions", "index.ts"), "utf8");
	assert.doesNotMatch(text, /codegraph-workflow|SKILL_REMINDER|skill reminder/);
});
