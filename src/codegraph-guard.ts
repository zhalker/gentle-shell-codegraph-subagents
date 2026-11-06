import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { foldRoot } from "./paths.ts";

// A rule in a user's AGENTS.md can make the model run `codegraph index` before every search. That rebuilds the
// whole index and stops the daemon this package keeps warm, so every search gets slower and the package looks
// broken. The guard blocks that rebuild where an index exists, and the user is told about the rule once per project.

/** A command that sets this variable to 1 is never blocked: the way to ask for a deliberate rebuild. */
export const ALLOW_ENV = "CODEGRAPH_SUBAGENTS_ALLOW";

export type IndexCommand = "init" | "index" | "sync";
const COMMAND_ORDER: IndexCommand[] = ["init", "index", "sync"];

/** The nearest folder at or above `start` that holds a CodeGraph index; the global ~/.codegraph has no database. */
export function findIndexRoot(start: string, exists: (path: string) => boolean = existsSync): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (exists(join(dir, ".codegraph", "codegraph.db"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Words of one simple command; quotes are dropped. Good enough to recognise a command, not a shell parser. */
function words(segment: string): string[] {
	const out: string[] = [];
	for (const match of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3]);
	return out;
}

/** The project a `codegraph index` in this simple command would rebuild, or undefined when it is another command. */
function indexTarget(segment: string, cwd: string): string | undefined {
	const list = words(segment);
	let at = 0;
	while (at < list.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[at])) at++;
	if (list[at] === "npx") {
		at++;
		while (at < list.length && list[at].startsWith("-")) at++;
	}
	const program = list[at];
	if (program === undefined || !/^codegraph(\.cmd|\.exe)?$/i.test(basename(program.replace(/\\/g, "/")))) return undefined;
	if (list[at + 1] !== "index") return undefined;
	const path = list.slice(at + 2).find((word) => !word.startsWith("-"));
	return path === undefined ? cwd : resolve(cwd, path);
}

/**
 * The reason to block a shell command that runs `codegraph index` on a project that already has an index, or
 * undefined to let it run. A `cd` inside the command is not followed; the escape hatch covers what this misses.
 */
export function guardIndexCommand(input: { command: string; cwd: string; exists?: (path: string) => boolean }): string | undefined {
	if (new RegExp(`(^|[^A-Za-z0-9_])${ALLOW_ENV}=1(?![0-9])`).test(input.command)) return undefined;
	for (const segment of input.command.split(/\r?\n|&&|\|\||[;|&]/)) {
		const target = indexTarget(segment, input.cwd);
		if (target === undefined) continue;
		const root = findIndexRoot(target, input.exists);
		if (root === undefined) continue;
		return [
			`Blocked by gentle-shell-codegraph-subagents: ${root} already has a CodeGraph index.`,
			"This extension syncs it when the session starts and the CodeGraph daemon keeps it current; rebuilding it with `codegraph index` stops the running daemon and slows every search until it is warm again.",
			"Query the index with the CodeGraph tool instead. After large changes made outside the session (git pull, checkout, rebase), run `codegraph sync`.",
			`Only when the user explicitly asks for a full rebuild, run \`${ALLOW_ENV}=1 codegraph index\`.`,
		].join(" ");
	}
	return undefined;
}

export interface ContextFile {
	path: string;
	content: string;
}

export interface RuleConflict {
	path: string;
	commands: IndexCommand[];
}

const COMMAND_MENTION = /(?<![.\w/\\-])codegraph(?:\.cmd)?\s+(init|index|sync)\b/gi;
const EVERY_USE = /\balways\b|\bbefore (?:any|every|each)\b|\b(?:every|each) time\b/i;
const NEGATED = /\b(?:do not|don't|never|avoid)\b/i;

/**
 * The context files whose rules ask to run `codegraph index`, or `codegraph init` or `sync` always or before
 * every use. One sentence at a time; a negated sentence ("do not", "never") is not a conflict. A heuristic:
 * a rule worded very differently is not seen.
 */
export function findRuleConflicts(files: readonly ContextFile[]): RuleConflict[] {
	const out: RuleConflict[] = [];
	for (const file of files) {
		const found = new Set<IndexCommand>();
		for (const sentence of file.content.split(/(?<=[.!?])\s+|;|\r?\n/)) {
			if (NEGATED.test(sentence)) continue;
			for (const match of sentence.matchAll(COMMAND_MENTION)) {
				const command = match[1].toLowerCase() as IndexCommand;
				if (command === "index" || EVERY_USE.test(sentence)) found.add(command);
			}
		}
		if (found.size > 0) out.push({ path: file.path, commands: COMMAND_ORDER.filter((command) => found.has(command)) });
	}
	return out;
}

/** The warning for the user: which files, why they conflict, and what happens if the rule stays. */
export function conflictWarning(conflicts: readonly RuleConflict[]): string {
	return [
		"gentle-shell-codegraph-subagents: a context file asks the model to run CodeGraph index commands this extension already handles.",
		...conflicts.map((conflict) => `- ${conflict.path}: ${conflict.commands.map((command) => `codegraph ${command}`).join(", ")}`),
		"Why it conflicts: this extension already creates and syncs the index when a session starts, and the CodeGraph daemon keeps it current while you work.",
		"If the rule stays: `codegraph index` rebuilds the whole index and stops the daemon (the extension blocks it where an index exists), and `codegraph init` or `sync` before every use adds a run to every search, where runs from parallel subagents can collide. Searches get slower, not fresher.",
		"Suggested fix: remove the rule, or keep `codegraph sync` only for large changes made outside the session (git pull, checkout, rebase).",
		"This warning shows once per project.",
	].join("\n");
}

const NOTICES_FILE = "conflict-notices.json";

function shownProjects(file: string): string[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const projects = (parsed as { projects?: unknown })?.projects;
		return Array.isArray(projects) ? projects.filter((p): p is string => typeof p === "string") : [];
	} catch {
		return [];
	}
}

/**
 * The warning to show for this project, once: the project is recorded, never the files or their contents.
 * When the record cannot be written the warning is still returned; it may then come back next session.
 */
export function takeConflictNotice(input: {
	root: string;
	conflicts: readonly RuleConflict[];
	stateDir?: string;
}): string | undefined {
	if (input.conflicts.length === 0) return undefined;
	const dir = input.stateDir ?? join(homedir(), ".pi", "agent", "codegraph-subagents");
	const file = join(dir, NOTICES_FILE);
	const root = foldRoot(input.root);
	const projects = shownProjects(file);
	if (projects.includes(root)) return undefined;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, JSON.stringify({ projects: [...projects, root] }, null, "\t") + "\n");
	} catch {
		// A record that cannot be written must never break a prompt.
	}
	return conflictWarning(input.conflicts);
}
