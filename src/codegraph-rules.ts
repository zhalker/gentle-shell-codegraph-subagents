import { codegraphTools } from "./agents.ts";

// S2/S3: one generic CodeGraph rule for every session that can call CodeGraph (the orchestrator and the
// subagents, except the reviewers). It rides `systemPromptOptions.appendSystemPrompt` and is never returned as a
// replacement prompt: a replacement is dropped by some hosts and would erase the harness's own text. The heading
// is the identity of the block, so a section that is already there is never added twice.

export const SECTION_MARKER = "## CodeGraph";

/** The three-bullet block recovered from the `codegraph-native` worktree's orchestrator and explorer assets. */
export const RULE_BULLETS: readonly string[] = [
	"- For structural questions — where something is defined, who calls it, how a flow works — use the cwd-scoped `codegraph` tool before symbol searches with `rg` or `grep` and before broad `find`. The same applies when the work is a refactor, a review, an analysis or a fix. `query` finds symbols; `explore` returns source plus call paths. Run `operation: \"init\"` first when the index is needed: it creates `.codegraph/` when absent and updates it when present. Never ask it to target another path.",
	"- `codegraph` may create or update only the current workspace `.codegraph/` index. This is the sole permitted mutation; all tracked files, source files, and other project content remain read-only.",
	"- If CodeGraph reports that it is unavailable or fails, then use `read`, `grep`, and `find` as the fallback. Do not use that fallback before CodeGraph is unavailable or fails.",
];

export interface CodegraphSectionInput {
	/** The session's tools: the selected ones plus, for a child, the ones gentle-pi requested for it. */
	tools: readonly string[];
	/** The nearest directory holding `.codegraph/codegraph.db`: the checkout has an index. */
	root?: string;
}

/**
 * The system-prompt section for a session whose tools include the native `codegraph` tool or the MCP explore
 * tool; `undefined` for a session holding neither, which is how a reviewer stays out. When the checkout has an
 * index, one line inside the section says so instead of a separate notice.
 */
export function codegraphSection(input: CodegraphSectionInput): string | undefined {
	if (!Array.isArray(input?.tools)) return undefined;
	if (codegraphTools(input.tools).length === 0) return undefined;
	const lines = [SECTION_MARKER, "", ...RULE_BULLETS];
	if (typeof input.root === "string" && input.root.length > 0) {
		lines.push(`- This workspace HAS a CodeGraph index at ${input.root}; the extension verified that \`.codegraph/codegraph.db\` exists.`);
	}
	return lines.join("\n");
}

/** The part of Pi's `before_agent_start` event this hook reads and mutates. */
export interface AppendablePromptEvent {
	systemPromptOptions?: { appendSystemPrompt?: unknown } | undefined;
}

function separatorFor(existing: string): string {
	if (existing.endsWith("\n\n")) return "";
	if (existing.endsWith("\n")) return "\n";
	return "\n\n";
}

/**
 * Appends the section after whatever the prompt options already carry, in place. An event without options, a
 * non-string append field, or an already-injected section is left alone. Nothing here throws into the run: the
 * prompt keeps exactly what the harness wrote, plus the section when it can be added.
 */
export function appendCodegraphSection(event: AppendablePromptEvent | undefined, section: string | undefined): void {
	try {
		if (typeof section !== "string" || section.length === 0) return;
		const options = event?.systemPromptOptions;
		if (!options || typeof options !== "object") return;
		const existing = typeof options.appendSystemPrompt === "string" ? options.appendSystemPrompt : "";
		if (existing.includes(SECTION_MARKER)) return;
		// Append-only: every existing byte stays the prefix of the new value.
		options.appendSystemPrompt = existing.length === 0 ? section : `${existing}${separatorFor(existing)}${section}`;
	} catch {
		// The prompt block is best effort and must never break a run.
	}
}
