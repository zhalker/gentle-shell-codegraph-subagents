import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// A rule in a user's AGENTS.md can make the model run `codegraph index` before every search. That rebuilds the
// whole index and stops the daemon this package keeps warm, so every search gets slower and the package looks
// broken. The guard blocks that rebuild where an index exists and tells the model what to do instead.

/** A command that sets this variable to 1 is never blocked: the way to ask for a deliberate rebuild. */
export const ALLOW_ENV = "CODEGRAPH_SUBAGENTS_ALLOW";

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
