import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

test("S1/S5: package includes and declares the approved CodeGraph skill", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.ok(manifest.files.includes("skills"), "npm includes the skill");
	assert.ok(manifest.pi.skills.includes("./skills"), "Pi discovers the skill");
	const file = join(root, "skills", "codegraph-workflow", "SKILL.md");
	assert.ok(existsSync(file));
	const text = readFileSync(file, "utf8");
	assert.match(text, /^---\r?\nname: codegraph-workflow\r?\ndescription: .+\r?\n---/);
	assert.match(text, /Do not run `codegraph index` before every query/);
	assert.match(text, /Respect each subagent's tool restrictions/);
});
