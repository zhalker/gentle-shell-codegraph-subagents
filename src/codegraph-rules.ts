import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codegraphTools } from "./agents.ts";

// S1/S2/S5: the approved wording of the rule lives in one Markdown file per role under `src/codegraph-rules/`, so
// it can be read and edited without touching code, and each session gets the text of its own role: the primary
// session's (the orchestrator), a gentle-shell agent's, or the generic text for any other child and for a file that
// cannot be read. The section rides `systemPromptOptions.appendSystemPrompt` and is never returned as a replacement
// prompt: a replacement is dropped by some hosts and would erase the harness's own text. The heading is the identity
// of the block, so a section that is already there is never added twice.

export const SECTION_MARKER = "## CodeGraph";

/** The seven approved texts, one per role; each is `<variant>.md` in `src/codegraph-rules/`. */
export const RULE_VARIANTS = ["orchestrator", "explore", "verify", "worker", "fix", "judge", "generic"] as const;

export type RuleVariant = (typeof RULE_VARIANTS)[number];

/** S2: the agent name → text table. Both judges share one text, and the reviewers have none at all (S3). */
export const RULE_VARIANT_BY_AGENT: Readonly<Record<string, RuleVariant>> = {
	"gentle-ai-explore": "explore",
	"gentle-ai-verify": "verify",
	"gentle-ai-worker": "worker",
	"jd-fix-agent": "fix",
	"jd-judge-a": "judge",
	"jd-judge-b": "judge",
};

/** Which session a selection is made for: the agent name read from a child's own argv, and whether it is a child. */
export interface RuleSession {
	/** The agent name from the child's own command line; absent when it could not be read. */
	agent?: string | undefined;
	/** Whether this session is a subagent child at all. A primary session gets the orchestrator text. */
	child?: boolean | undefined;
}

/**
 * S2: the text of one session. A primary session gets the orchestrator's, a named gentle-shell agent its own, and
 * any other child — one whose name the table does not carry, or whose name could not be read at all — the generic
 * text, which is also the text of a subagent outside gentle-ai.
 */
export function ruleVariant(session: RuleSession | undefined): RuleVariant {
	if (session?.child !== true) return "orchestrator";
	const agent = session.agent;
	if (typeof agent !== "string" || agent.length === 0) return "generic";
	return RULE_VARIANT_BY_AGENT[agent] ?? "generic";
}

/** S3: a reviewer is named `review-*`; it gets no section whatever tools it holds. */
export function isReviewerAgent(agent: string | undefined): boolean {
	return typeof agent === "string" && agent.startsWith("review-");
}

/** S1: how one rule file is read. The default is the real file system, as UTF-8 text. */
export type RuleReader = (file: string) => string;

/** The directory holding the seven texts, next to this module; `package.json` ships all of `src`. */
export const RULE_DIRECTORY = fileURLToPath(new URL("./codegraph-rules/", import.meta.url));

/** The shipped text of one variant, or `undefined` when it cannot be used; never throws. */
export type RuleTexts = (variant: RuleVariant) => string | undefined;

function readRuleFile(file: string): string {
	return readFileSync(file, "utf8");
}

/**
 * S2: the texts of one run, each file read at most once and never throwing. A file that cannot be read — missing,
 * unreadable, or not opening with the heading — gives the generic text, so a broken install still leaves the
 * session its rule; a generic text that cannot be read either gives `undefined`, which is no section at all rather
 * than a broken session.
 */
export function createRuleTexts(read: RuleReader = readRuleFile, directory: string = RULE_DIRECTORY): RuleTexts {
	const cache = new Map<RuleVariant, string | undefined>();
	const load = (variant: RuleVariant): string | undefined => {
		try {
			const text = read(join(directory, `${variant}.md`)).trimEnd();
			if (text.startsWith(SECTION_MARKER)) return text;
		} catch {
			// The fallback below is the whole handling: the session never sees this failure.
		}
		return variant === "generic" ? undefined : text("generic");
	};
	const text = (variant: RuleVariant): string | undefined => {
		if (cache.has(variant)) return cache.get(variant);
		const loaded = load(variant);
		cache.set(variant, loaded);
		return loaded;
	};
	return text;
}

/** The one cache of this process: the approved texts ship with the package and do not change under a run. */
const defaultRuleTexts: RuleTexts = createRuleTexts();

export interface CodegraphSectionInput extends RuleSession {
	/** The session's tools: the selected ones plus, for a child, the ones gentle-pi requested for it. */
	tools: readonly string[];
	/** The nearest directory holding `.codegraph/codegraph.db`: the checkout has an index. */
	root?: string;
	/** The variant texts; the default reads each file of `RULE_DIRECTORY` once and keeps it. */
	rules?: RuleTexts;
}

/**
 * The system-prompt section of this session's role: the approved text of that variant, plus one line when the
 * checkout has an index. `undefined` — no section — for a session whose tools include neither the native `codegraph`
 * tool nor the MCP explore tool, for a reviewer, and for a text that cannot be read.
 */
export function codegraphSection(input: CodegraphSectionInput): string | undefined {
	if (!Array.isArray(input?.tools)) return undefined;
	if (isReviewerAgent(input.agent)) return undefined;
	if (codegraphTools(input.tools).length === 0) return undefined;
	const text = (input.rules ?? defaultRuleTexts)(ruleVariant(input));
	if (typeof text !== "string" || text.length === 0) return undefined;
	const lines = [text];
	if (typeof input.root === "string" && input.root.length > 0) {
		lines.push(`- This workspace HAS a CodeGraph index at ${input.root}; the extension verified that \`.codegraph/codegraph.db\` exists.`);
	}
	return lines.join("\n\n");
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
