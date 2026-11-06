import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CODEGRAPH_MCP_TOOL } from "./agents.ts";
import type { PerCaseOutcome } from "./prefetch.ts";
import { SKILL_REMINDER_TYPE } from "./skill-reminder.ts";

// A live explorer run had the CodeGraph MCP tool, was told to use it only "in an already indexed workspace",
// checked with Pi's find tool, got nothing because .codegraph/ is git-ignored, and never called CodeGraph.
// The extension can see the index, so it states the fact instead of leaving the model to guess.

export const INDEX_NOTICE_TYPE = "codegraph-index-notice";
export const INDEX_NOTICE_MARKER = "[codegraph-index]";

/** Nearest directory at or above cwd holding .codegraph/codegraph.db. */
export function findIndexRoot(cwd: string, exists: (path: string) => boolean = existsSync): string | undefined {
	for (let dir = resolve(cwd); ;) {
		if (exists(join(dir, ".codegraph", "codegraph.db"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** CodeGraph tools among the selected ones; the MCP wildcard stands for the explore tool. */
export function codegraphTools(selectedTools: readonly string[]): string[] {
	const tools: string[] = [];
	if (selectedTools.includes("codegraph")) tools.push("codegraph");
	if (selectedTools.some((tool) => tool === CODEGRAPH_MCP_TOOL || tool === "mcp__codegraph__*")) tools.push(CODEGRAPH_MCP_TOOL);
	return tools;
}

/**
 * Tools to consider for the notice. In a subagent child the MCP tools are not in selectedTools yet when
 * before_agent_start runs, so the tool list gentle-pi requested for the child counts too.
 */
export function noticeTools(selectedTools: readonly string[], requestedToolsEnv: string | undefined, child: boolean): string[] {
	const requested = child ? (requestedToolsEnv ?? "").split(",").map((tool) => tool.trim()).filter(Boolean) : [];
	return [...new Set([...selectedTools, ...requested])];
}

function toolLine(tools: string[]): string {
	const parts: string[] = [];
	if (tools.includes("codegraph")) parts.push('the `codegraph` tool (operation "explore" with symbol names or a question returns verbatim source plus call paths; "query" searches symbols)');
	if (tools.includes(CODEGRAPH_MCP_TOOL)) parts.push(`\`${CODEGRAPH_MCP_TOOL}\` (verbatim source plus call paths in one call)`);
	return parts.join(", or ");
}

export function indexNotice(root: string, tools: string[]): string {
	return [
		`${INDEX_NOTICE_MARKER} This workspace HAS a CodeGraph index at ${root}. The extension verified that .codegraph/codegraph.db exists.`,
		`- To locate or understand code (where X is defined, who calls Y, how Z works), call ${toolLine(tools)} FIRST, before grep, find or broad reads.`,
		"- Do not use find, grep or ls to check whether the index exists: .codegraph/ is git-ignored, so those tools never show it.",
		"- Use read for exact line ranges once you know the file, and grep for string literals CodeGraph does not index (translations, configs, docs) or when CodeGraph did not find what you need.",
		'- If CodeGraph reports a file "changed on disk after the last index sync", read that file directly with targeted line ranges instead of falling back to recursive search.',
	].join("\n");
}

export interface IndexNoticeInput {
	cwd: string;
	selectedTools: readonly string[];
	isUserPrompt: boolean;
	alreadySent: boolean;
	exists?: (path: string) => boolean;
}

/** The notice for the first user prompt of a session that has an index and a CodeGraph tool; otherwise undefined. */
export function chooseIndexNotice(input: IndexNoticeInput): string | undefined {
	if (!input.isUserPrompt || input.alreadySent) return undefined;
	const tools = codegraphTools(input.selectedTools);
	if (tools.length === 0) return undefined;
	const root = findIndexRoot(input.cwd, input.exists);
	return root === undefined ? undefined : indexNotice(root, tools);
}

/** What the extension can record for one explorer prefetch: its own cases plus a held init lock, which skips it. */
export type PrefetchOutcome = PerCaseOutcome | "skipped-init-running";

/** Appends one line per explorer prefetch, so a failure that the model never sees can still be diagnosed. */
export function logPrefetch(
	entry: { cwd: string; outcome: PrefetchOutcome; ms: number },
	dir: string = join(homedir(), ".pi", "agent", "codegraph-subagents"),
): void {
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "prefetch.log"), `${new Date().toISOString()}\t${entry.outcome}\t${entry.ms}ms\t${entry.cwd}\n`);
	} catch {
		// Logging must never break a prompt.
	}
}

export interface FirstPromptParts {
	/** The index notice, when this prompt gets one. */
	notice?: string;
	/** The codegraph-workflow skill reminder, when this prompt gets one. */
	reminder?: string;
	/** The CodeGraph pre-fetch of an explorer child, when it produced anything. */
	prefetch?: string;
	child: boolean;
}

export interface PromptMessage {
	customType: string;
	content: string;
	display: boolean;
}

/**
 * The one message the first prompt carries. The skill reminder gives the type, then the notice, then the
 * pre-fetch; only a notice shown to the main session is displayed in the transcript. Children keep it hidden.
 */
export function firstPromptMessage(input: FirstPromptParts): PromptMessage | undefined {
	const part = (text: string | undefined): string | undefined => (text !== undefined && text.length > 0 ? text : undefined);
	const notice = part(input.notice);
	const reminder = part(input.reminder);
	const prefetch = part(input.prefetch);
	const content = [notice, reminder, prefetch].filter((text): text is string => text !== undefined).join("\n\n");
	if (content.length === 0) return undefined;
	const customType = reminder !== undefined ? SKILL_REMINDER_TYPE : notice !== undefined ? INDEX_NOTICE_TYPE : "codegraph-prefetch";
	return { customType, content, display: !input.child && notice !== undefined };
}
