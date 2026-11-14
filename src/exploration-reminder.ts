import { CHILD_ENV, CODEGRAPH_MCP_TOOL, indexRole, NATIVE_CODEGRAPH_TOOL, requestedTools } from "./agents.ts";

// S6/S7: a session that can call CodeGraph is reminded once, on its first search-shaped call made before any
// CodeGraph call, and never blocked: the reminder is one message, the call still runs. The budget is per session
// and starts over after a compaction. The primary session and a read-only explorer-style child get it; a child
// that writes files does not.

export const EXPLORATION_REMINDER_TYPE = "codegraph-exploration-reminder";

/** One bounded message naming the rule; it is a reminder, never a veto of the search. */
export const EXPLORATION_REMINDER = "CodeGraph first: this session can call CodeGraph and has not called it yet, and a search is starting. For structural questions, call the `codegraph` tool (or `mcp__codegraph__codegraph_explore`) before `grep`, `find` or `ls`, as the `## CodeGraph` part of your instructions says. If CodeGraph is unavailable or fails, the fallback search is correct. This reminder does not block anything: the call you just made still runs.";

/** What this session has done so far; in memory, so a compaction is the only reset that matters. */
export interface ExplorationBudget {
	codegraphCalled: boolean;
	reminded: boolean;
}

export function createExplorationBudget(): ExplorationBudget {
	return { codegraphCalled: false, reminded: false };
}

/**
 * Who may receive the reminder: the primary session (`GENTLE_PI_AGENTS_CHILD` unset) and a read-only
 * explorer-style child (the explorer, or verify and the judges). A child that writes files is never reminded.
 */
export function reminderAudience(env: Record<string, string | undefined>): boolean {
	if (env[CHILD_ENV] !== "1") return true;
	const role = indexRole(requestedTools(env));
	return role === "explorer" || role === "read-only";
}

/** Whether this tool is CodeGraph itself, native or through the MCP explore tool. */
export function isCodegraphCall(toolName: unknown): boolean {
	return toolName === NATIVE_CODEGRAPH_TOOL || toolName === CODEGRAPH_MCP_TOOL;
}

const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);

// A shell command that looks for something: grep, rg, find, fd, ls and their usual cousins, as a word of the
// command line (including after a pipe or `xargs`) rather than inside an option or a filename.
const SEARCH_COMMAND = /(?:^|[\s;&|()`"'=/])(?:grep|egrep|fgrep|rg|ag|ack|find|fd|fdfind|ls|dir|gci|get-childitem)(?=$|[\s;&|()`"'])/i;

/** Whether a shell command searches the tree. */
export function searchesInBash(command: unknown): boolean {
	return typeof command === "string" && SEARCH_COMMAND.test(command);
}

function searches(toolName: unknown, input: unknown): boolean {
	if (typeof toolName !== "string") return false;
	if (SEARCH_TOOLS.has(toolName)) return true;
	if (toolName !== "bash" && toolName !== "powershell") return false;
	const command = input !== null && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
	return searchesInBash(command);
}

/**
 * One observed tool call. A CodeGraph call is recorded; the first search-shaped call that arrives before any
 * CodeGraph call returns the reminder, once, and every later call returns nothing. An unreadable call is simply
 * not a search: this function never throws into the session.
 */
export function observeToolCall(budget: ExplorationBudget, call: { toolName?: unknown; input?: unknown } | undefined): string | undefined {
	try {
		if (isCodegraphCall(call?.toolName)) {
			budget.codegraphCalled = true;
			return undefined;
		}
		if (budget.reminded || budget.codegraphCalled) return undefined;
		if (!searches(call?.toolName, call?.input)) return undefined;
		budget.reminded = true;
		return EXPLORATION_REMINDER;
	} catch {
		return undefined;
	}
}

/** A compaction drops the reminder from what the model sees, so the session gets one fresh budget. */
export function resetExplorationBudget(budget: ExplorationBudget): void {
	budget.codegraphCalled = false;
	budget.reminded = false;
}
