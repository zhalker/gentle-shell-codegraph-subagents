// Frozen copies of the normalizers published versions of this package shipped. They are never used to
// write a file: they only recognise a frozen agent file as something one of those versions produced, so the
// repair can hand it back to gentle-pi without losing anything (the backup holds the same bytes).
//
// 0.2.0 to 0.6.0 share one normalizer (`git show v0.6.0:src/agents.ts`, worker marker from
// `git show v0.6.0:src/skill-reminder.ts`). 0.1.0 (`git show 5f0eb3e:src/agents.ts`'s parent commit
// dbac2dd) is the same file without the worker marker append. Do not edit these functions to follow the
// live normalizer: a change here would stop recognising files the old versions really wrote.

const WORKER_MARKER_V060 = "<!-- codegraph-workflow:worker -->";

const CODEGRAPH_MCP_TOOL_V060 = "mcp__codegraph__codegraph_explore";

const EXPLORER_V060 = "gentle-ai-explore";
const AGENTS_WITH_MCP_TOOL_V060 = new Set([
	"gentle-ai-explore",
	"gentle-ai-verify",
	"gentle-ai-worker",
	"jd-fix-agent",
	"jd-judge-a",
	"jd-judge-b",
]);

const FRONTMATTER_V060 = /^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/;
const GENTLE_AI_BLOCK_V060 = /<!-- gentle-ai:pi-codegraph-(?:tool|guidance) -->[\s\S]*?<!-- \/gentle-ai:pi-codegraph -->/g;
const MARKER_V060 = "\u0000";

function unquoteV060(value: string): string {
	const v = value.trim();
	return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
}

function isBrokenEntryV060(item: string): boolean {
	return /\*["']?\s*:\s*false/.test(item);
}

const EXPLORER_STRUCTURAL_LINE_V060 = "- For structural questions, use the cwd-scoped `codegraph` tool";
const EXPLORER_INDEX_LINE_V060 = "- `codegraph` may create or update only the current workspace `.codegraph/` index";
const EXPLORER_READ_ONLY_PHRASE_V060 = "Other than the explicit `.codegraph/` index exception, read and search only.";

function rewriteExplorerInstructionsV060(body: string, eol: string): string {
	if (!body.includes("codegraph")) return body;
	const out: string[] = [];
	for (const line of body.split(eol)) {
		if (line.startsWith(EXPLORER_STRUCTURAL_LINE_V060)) {
			out.push(`- For structural questions, use the \`${CODEGRAPH_MCP_TOOL_V060}\` tool before broad filesystem searches. It reads the existing \`.codegraph/\` index and cannot create one; when the project has none, use \`read\`, \`grep\`, and \`find\` and say so in the handoff.`);
		} else if (line.startsWith(EXPLORER_INDEX_LINE_V060)) {
			continue;
		} else {
			out.push(line.replace(EXPLORER_READ_ONLY_PHRASE_V060, "Read and search only."));
		}
	}
	return out.join(eol);
}

function removeBlocksV060(body: string, eol: string): string {
	if (!body.includes("gentle-ai:pi-codegraph")) return body;
	const marked = body.replace(GENTLE_AI_BLOCK_V060, MARKER_V060);
	return marked.replace(/\s*\u0000(?:\s*\u0000)*\s*/g, (match, offset: number) => {
		if (offset === 0) return "";
		return offset + match.length >= marked.length ? eol : eol + eol;
	});
}

function editToolsV060(front: string, eol: string): string {
	const lines = front.split(/\r?\n/);
	const nameLine = lines.find((line) => /^name:/.test(line));
	const name = nameLine ? unquoteV060(nameLine.slice("name:".length)) : "";
	const at = lines.findIndex((line) => /^tools:/.test(line));
	if (at === -1) return front;

	const rest = lines[at].slice("tools:".length).trim();
	let style: "bracket" | "csv" | "list";
	let items: string[];
	let consumed = 1;
	let indent = "  ";
	if (rest.startsWith("[")) {
		style = "bracket";
		items = rest.replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim()).filter(Boolean);
	} else if (rest.length > 0) {
		style = "csv";
		items = rest.split(",").map((s) => s.trim()).filter(Boolean);
	} else {
		style = "list";
		items = [];
		for (let i = at + 1; i < lines.length; i++) {
			const m = /^(\s*)-\s+(.*)$/.exec(lines[i]);
			if (!m) break;
			if (items.length === 0) indent = m[1];
			items.push(m[2].trim());
			consumed++;
		}
	}
	if (items.length === 0) return front;

	let next = items.filter((item) => unquoteV060(item) !== "mcp" && !isBrokenEntryV060(item));
	if (name === EXPLORER_V060) next = next.filter((item) => unquoteV060(item) !== "codegraph");
	if (AGENTS_WITH_MCP_TOOL_V060.has(name) && !next.some((item) => unquoteV060(item) === CODEGRAPH_MCP_TOOL_V060)) next.push(CODEGRAPH_MCP_TOOL_V060);
	if (next.length === 0 || next.join("\n") === items.join("\n")) return front;

	const replacement =
		style === "list" ? ["tools:", ...next.map((item) => `${indent}- ${item}`)]
		: style === "bracket" ? [`tools: [${next.join(", ")}]`]
		: [`tools: ${next.join(", ")}`];
	return [...lines.slice(0, at), ...replacement, ...lines.slice(at + consumed)].join(eol);
}

/** The normalizer shipped in 0.2.0, 0.3.0, 0.4.0, 0.5.0 and 0.6.0. */
export function normalizeAgentV020ToV060(text: string): string {
	const match = FRONTMATTER_V060.exec(text);
	if (!match) return text;
	const [, open, front, close, body] = match;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const name = /^name:\s*(.+)$/m.exec(front)?.[1];
	const cleaned = removeBlocksV060(body, eol);
	let rewritten = name !== undefined && unquoteV060(name) === EXPLORER_V060 ? rewriteExplorerInstructionsV060(cleaned, eol) : cleaned;
	if (name !== undefined && unquoteV060(name) === "gentle-ai-worker" && !rewritten.includes(WORKER_MARKER_V060)) {
		rewritten = rewritten.trimEnd() + eol + eol + WORKER_MARKER_V060 + eol;
	}
	return open + editToolsV060(front, eol) + close + rewritten;
}

/** The normalizer shipped in 0.1.0: identical, except it never appended the worker marker. */
export function normalizeAgentV010(text: string): string {
	const match = FRONTMATTER_V060.exec(text);
	if (!match) return text;
	const [, open, front, close, body] = match;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const name = /^name:\s*(.+)$/m.exec(front)?.[1];
	const cleaned = removeBlocksV060(body, eol);
	const rewritten = name !== undefined && unquoteV060(name) === EXPLORER_V060 ? rewriteExplorerInstructionsV060(cleaned, eol) : cleaned;
	return open + editToolsV060(front, eol) + close + rewritten;
}
