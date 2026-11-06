import { INDEX_NOTICE_MARKER } from "./index-notice.ts";
import { SKILL_REMINDER_TYPE } from "./skill-reminder.ts";

// A compaction replaces the older part of a session with a summary: the model then sees the summary plus the
// entries from the compaction's first kept entry on (Pi docs, compaction.md and session-format.md). The index
// notice and the skill reminder of the first prompt usually fall in the summarized part, yet they stay on the
// session branch. So whether they were "already sent" is decided on what the model still sees, not on the branch:
// once a compaction drops them, the next user prompt carries them again. Nothing is stored, so a restarted or
// resumed session reaches the same answer.

/** The fields of a session entry read here; Pi's entries carry more. */
export interface BranchEntry {
	type: string;
	id: string;
	firstKeptEntryId?: string;
	customType?: string;
	content?: unknown;
}

/**
 * The entries the model sees now, in branch order: everything without a compaction; otherwise, from the last
 * compaction's first kept entry on. A kept entry missing from the branch, or a compaction that keeps nothing
 * (its own id), leaves the compaction and what follows it.
 */
export function contextEntries<T extends BranchEntry>(branch: readonly T[]): T[] {
	let last = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") { last = i; break; }
	}
	if (last < 0) return [...branch];
	const keptId = branch[last].firstKeptEntryId;
	const kept = branch.findIndex((entry, i) => i < last && entry.id === keptId);
	return branch.slice(kept >= 0 ? kept : last);
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

export interface PromptContext {
	/** The index notice is in what the model sees. */
	noticeInContext: boolean;
	/** The codegraph-workflow skill reminder is in what the model sees. */
	reminderInContext: boolean;
	/** The session was compacted at least once: whatever is sent now is a reinjection. */
	afterCompaction: boolean;
}

/** What the model still has of this package's first-prompt message. Only this package's custom messages count. */
export function promptContext(branch: readonly BranchEntry[]): PromptContext {
	const visible = contextEntries(branch).filter((entry) => entry.type === "custom_message");
	return {
		noticeInContext: visible.some((entry) => text(entry.content).includes(INDEX_NOTICE_MARKER)),
		reminderInContext: visible.some((entry) => entry.customType === SKILL_REMINDER_TYPE),
		afterCompaction: branch.some((entry) => entry.type === "compaction"),
	};
}

/** Text of a custom message, whether Pi stored it as a string or as content parts. */
export function messageText(content: unknown): string {
	return text(content);
}

/**
 * How the first-prompt message is drawn: collapsed, one line naming what was added and how to expand it;
 * expanded, exactly the text the model received. Drawing only: the message content never changes.
 */
export function promptMessageLine(content: string, expanded: boolean, hint: string): string {
	if (expanded) return content;
	const parts: string[] = [];
	if (content.includes(INDEX_NOTICE_MARKER)) parts.push("index notice");
	if (content.includes("codegraph-workflow skill")) parts.push("skill reminder");
	if (content.includes("CodeGraph pre-fetch")) parts.push("pre-fetch");
	const named = parts.length === 0 ? "context" : parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
	return `CodeGraph: ${named} added to the model's context (${hint})`;
}
