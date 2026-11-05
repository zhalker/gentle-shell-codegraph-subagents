import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const WORKER_MARKER = "<!-- codegraph-workflow:worker -->";
export const SKILL_REMINDER_TYPE = "codegraph-workflow-reminder";

interface LoadedSkill {
	name: string;
	filePath: string;
	disableModelInvocation?: boolean;
}

function normalizedPath(path: string): string {
	let result: string;
	try { result = realpathSync(path); } catch { result = resolve(path); }
	return process.platform === "win32" ? result.toLowerCase() : result;
}

/** Only refer to the packaged skill when Pi actually selected it, not a same-named user skill. */
export function chooseSkillReminder(input: {
	expectedPath: string;
	skills: LoadedSkill[];
	child: boolean;
	systemPrompt: string;
	alreadySent: boolean;
	isUserPrompt: boolean;
}): string | undefined {
	if (!input.isUserPrompt || input.alreadySent) return undefined;
	if (input.child && !input.systemPrompt.includes(WORKER_MARKER)) return undefined;
	const skill = input.skills.find((entry) => entry.name === "codegraph-workflow");
	if (!skill || skill.disableModelInvocation || normalizedPath(skill.filePath) !== normalizedPath(input.expectedPath)) return undefined;
	return `For applicable code tasks, read and follow the codegraph-workflow skill at ${skill.filePath}.`;
}
