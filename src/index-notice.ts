import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { codegraphTools, CODEGRAPH_MCP_TOOL, mayInitiateIndexWrite, NATIVE_CODEGRAPH_TOOL, type IndexRole } from "./agents.ts";
import type { AutoIndexResult, IndexAction, PostInitSyncOutcome } from "./autoindex.ts";
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
export { codegraphTools };

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
		"- Do not check whether the index exists: the extension already verified it. Pi's find and grep tools, fd and rg respect .gitignore, so they never show .codegraph/.",
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

export interface IndexNotice {
	text: string;
	level: "info" | "warning";
}

/**
 * What the index preparation is doing, said before it starts. Create-or-sync is one policy, and the wording
 * names which of the three actions this session took: an init, a worktree seed, or a sync of an existing index.
 */
export function indexStartNotice(action: Exclude<IndexAction, "none">): string {
	if (action === "init") return "creating the CodeGraph index of this project...";
	if (action === "seed") return "seeding this worktree's CodeGraph index from the main repo's index...";
	return "syncing the CodeGraph index...";
}

/**
 * How one index preparation ended, in honest terms. Only a run of this session that came back can be called
 * synced or created: a joined, coalesced, queued or unavailable request is reported as what it is, and a failed
 * command is never presented as a current index.
 */
export function indexOutcomeNotice(result: AutoIndexResult, cwd: string): IndexNotice {
	if (result.joined) {
		return {
			text: result.action === "init"
				? "another session is creating the CodeGraph index of this project"
				: "another session is writing this project's CodeGraph index; this session did not sync it",
			level: "info",
		};
	}
	if (result.coalesced) return { text: "another session's run completed the CodeGraph index sync requested here", level: "info" };
	if (result.queued) return { text: "the CodeGraph index sync is queued, not run yet: it waits for the index to be free", level: "info" };
	if (result.unavailable) return { text: `could not coordinate the CodeGraph index sync in ${cwd}; no sync was started`, level: "warning" };
	if (!result.ok) return { text: `codegraph ${result.action} failed in ${cwd}; the index is not up to date`, level: "warning" };
	if (result.action === "init") return { text: "CodeGraph index created", level: "info" };
	if (result.action === "seed") return { text: "CodeGraph index seeded from the main repo and synced", level: "info" };
	return { text: "CodeGraph index synced", level: "info" };
}

/** The daemon warm-up's outcome, kept apart from the index's: a warm daemon says nothing about the index. */
export function warmOutcomeNotice(outcome: "ok" | "failed", cwd: string): IndexNotice {
	return outcome === "ok"
		? { text: "CodeGraph ready", level: "info" }
		: { text: `CodeGraph warm-up failed in ${cwd}`, level: "warning" };
}

/** The parts of a finished Pi tool call this package reads. */
export interface ToolResultSummary {
	toolName: string;
	isError: boolean;
	input: Record<string, unknown>;
}

/** Whether this finished call was a successful native `codegraph init`: the one call the hook observes. */
export function isNativeInitResult(event: ToolResultSummary): boolean {
	return event.toolName === NATIVE_CODEGRAPH_TOOL && event.input?.operation === "init" && event.isError === false;
}

/**
 * What the post-`init` hook does with one finished tool call. Only a successful native `codegraph init` is
 * followed by the plugin's own coordinated sync; a failed init keeps its original error and triggers nothing.
 */
export type InitHookDecision = "sync" | "skip-not-a-native-init" | "skip-failed-init" | "skip-read-only";

export function initHookDecision(event: ToolResultSummary, role: IndexRole | undefined): InitHookDecision {
	if (event.toolName !== NATIVE_CODEGRAPH_TOOL || event.input?.operation !== "init") return "skip-not-a-native-init";
	if (event.isError) return "skip-failed-init";
	if (!mayInitiateIndexWrite(role)) return "skip-read-only";
	return "sync";
}

/**
 * The line the hook appends to the tool's own result. It never calls an unconfirmed index current: a pending or
 * failed request says so, and a read-only role says that no sync was requested at all.
 */
export function postInitSyncNotice(outcome: PostInitSyncOutcome): string {
	const lead = "gentle-shell-codegraph-subagents: after that `codegraph init`";
	if (outcome === "completed") return `${lead}, one coordinated index sync completed.`;
	if (outcome === "pending") {
		return `${lead}, a coordinated index sync is pending: the request is recorded and runs when the index is free. This index is not confirmed current yet.`;
	}
	if (outcome === "unavailable") {
		return `${lead}, no coordinated sync could be started (the coordination state was unusable); this index is not confirmed current.`;
	}
	if (outcome === "skipped-read-only") {
		return `${lead}, no sync was requested: this session's role is read-only, and verify and the judges never start an index write.`;
	}
	return `${lead}, the coordinated index sync failed; this index may be behind.`;
}

/** Appends one line of diagnostics to `file`; control characters in the folder become "?" so a record cannot be forged. */
function appendLog(dir: string, file: string, entry: { cwd: string; outcome: string; ms: number }): void {
	try {
		mkdirSync(dir, { recursive: true });
		const cwd = entry.cwd.replace(/[\u0000-\u001f\u007f]/g, "?");
		appendFileSync(join(dir, file), `${new Date().toISOString()}\t${entry.outcome}\t${entry.ms}ms\t${cwd}\n`);
	} catch {
		// Logging must never break a prompt.
	}
}

const DEFAULT_LOG_DIR = () => join(homedir(), ".pi", "agent", "codegraph-subagents");

/** Appends one line per explorer prefetch, so a failure that the model never sees can still be diagnosed. */
export function logPrefetch(
	entry: { cwd: string; outcome: PrefetchOutcome; ms: number },
	dir: string = DEFAULT_LOG_DIR(),
): void {
	appendLog(dir, "prefetch.log", entry);
}

/**
 * Appends one line per compaction sync request. A compaction sync never notifies the session, not even when it
 * failed, so this log is the only place its result can be seen.
 */
export function logSync(
	entry: { cwd: string; outcome: string; ms: number },
	dir: string = DEFAULT_LOG_DIR(),
): void {
	appendLog(dir, "sync.log", entry);
}

export interface FirstPromptParts {
	/** The index notice, when this prompt gets one. */
	notice?: string;
	/** The codegraph-workflow skill reminder, when this prompt gets one. */
	reminder?: string;
	/** The CodeGraph pre-fetch of an explorer child, when it produced anything. */
	prefetch?: string;
	child: boolean;
	/** The session was compacted before: this message brings back what the summary dropped, never displayed. */
	afterCompaction?: boolean;
}

export interface PromptMessage {
	customType: string;
	content: string;
	display: boolean;
}

/**
 * The one message the first prompt carries. The type follows precedence reminder, then notice, then pre-fetch;
 * its content is the notice, then the reminder, then the pre-fetch. Only a notice shown to the main session is
 * displayed in the transcript; children keep it hidden, and so does every message sent again after a compaction.
 */
export function firstPromptMessage(input: FirstPromptParts): PromptMessage | undefined {
	const part = (text: string | undefined): string | undefined => (text !== undefined && text.length > 0 ? text : undefined);
	const notice = part(input.notice);
	const reminder = part(input.reminder);
	const prefetch = part(input.prefetch);
	const content = [notice, reminder, prefetch].filter((text): text is string => text !== undefined).join("\n\n");
	if (content.length === 0) return undefined;
	const customType = reminder !== undefined ? SKILL_REMINDER_TYPE : notice !== undefined ? INDEX_NOTICE_TYPE : "codegraph-prefetch";
	return { customType, content, display: !input.child && input.afterCompaction !== true && notice !== undefined };
}
