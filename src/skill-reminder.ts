import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const WORKER_MARKER = "<!-- codegraph-workflow:worker -->";
export const SKILL_REMINDER_TYPE = "codegraph-workflow-reminder";

interface LoadedSkill {
	name: string;
	filePath: string;
	disableModelInvocation?: boolean;
}

// gentle-pi names the folder it hands a long agent body in after the agent: gentle-pi-subagent-<agent>-<random>.
const WORKER_INSTRUCTIONS_FOLDER = /^gentle-pi-subagent-gentle-ai-worker-/;

/**
 * gentle-pi gives a worker child no file marker and no env var, but it passes an agent body over 1000
 * bytes as a file after `--append-system-prompt`, inside a folder named after the agent. A child whose
 * system prompt still carries the marker (an agent file edited before this change) counts as well.
 */
export function isWorkerChild(argv: string[], systemPrompt: string): boolean {
	const at = argv.indexOf("--append-system-prompt");
	const instructions = at === -1 ? undefined : argv[at + 1];
	if (instructions !== undefined && instructions.split(/[\\/]+/).some((part) => WORKER_INSTRUCTIONS_FOLDER.test(part))) return true;
	return systemPrompt.includes(WORKER_MARKER);
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
	argv: string[];
	alreadySent: boolean;
	isUserPrompt: boolean;
}): string | undefined {
	if (!input.isUserPrompt || input.alreadySent) return undefined;
	if (input.child && !isWorkerChild(input.argv, input.systemPrompt)) return undefined;
	const skill = input.skills.find((entry) => entry.name === "codegraph-workflow");
	if (!skill || skill.disableModelInvocation || normalizedPath(skill.filePath) !== normalizedPath(input.expectedPath)) return undefined;
	return `For applicable code tasks, read and follow the codegraph-workflow skill at ${skill.filePath}.`;
}
