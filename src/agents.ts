import { WORKER_MARKER } from "./skill-reminder.ts";

export const CODEGRAPH_MCP_TOOL = "mcp__codegraph__codegraph_explore";

const EXPLORER = "gentle-ai-explore";
const AGENTS_WITH_MCP_TOOL = new Set([
	"gentle-ai-explore",
	"gentle-ai-verify",
	"gentle-ai-worker",
	"jd-fix-agent",
	"jd-judge-a",
	"jd-judge-b",
]);

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/;
const GENTLE_AI_BLOCK = /<!-- gentle-ai:pi-codegraph-(?:tool|guidance) -->[\s\S]*?<!-- \/gentle-ai:pi-codegraph -->/g;
const MARKER = "\u0000";

function unquote(value: string): string {
	const v = value.trim();
	return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
}

// The gentle-pi agent files ship a `- "*": false` list entry; Pi reads it as a tool named `*": false`.
function isBrokenEntry(item: string): boolean {
	return /\*["']?\s*:\s*false/.test(item);
}

const EXPLORER_STRUCTURAL_LINE = "- For structural questions, use the cwd-scoped `codegraph` tool";
const EXPLORER_INDEX_LINE = "- `codegraph` may create or update only the current workspace `.codegraph/` index";
const EXPLORER_READ_ONLY_PHRASE = "Other than the explicit `.codegraph/` index exception, read and search only.";

// The explorer loses its `codegraph` extension tool, so the lines that tell it to use or initialize that tool would send it nowhere.
function rewriteExplorerInstructions(body: string, eol: string): string {
	if (!body.includes("codegraph")) return body;
	const out: string[] = [];
	for (const line of body.split(eol)) {
		if (line.startsWith(EXPLORER_STRUCTURAL_LINE)) {
			out.push(`- For structural questions, use the \`${CODEGRAPH_MCP_TOOL}\` tool before broad filesystem searches. It reads the existing \`.codegraph/\` index and cannot create one; when the project has none, use \`read\`, \`grep\`, and \`find\` and say so in the handoff.`);
		} else if (line.startsWith(EXPLORER_INDEX_LINE)) {
			continue;
		} else {
			out.push(line.replace(EXPLORER_READ_ONLY_PHRASE, "Read and search only."));
		}
	}
	return out.join(eol);
}

function removeBlocks(body: string, eol: string): string {
	if (!body.includes("gentle-ai:pi-codegraph")) return body;
	const marked = body.replace(GENTLE_AI_BLOCK, MARKER);
	return marked.replace(/\s*\u0000(?:\s*\u0000)*\s*/g, (match, offset: number) => {
		if (offset === 0) return "";
		return offset + match.length >= marked.length ? eol : eol + eol;
	});
}


function editTools(front: string, eol: string): string {
	const lines = front.split(/\r?\n/);
	const nameLine = lines.find((line) => /^name:/.test(line));
	const name = nameLine ? unquote(nameLine.slice("name:".length)) : "";
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

	let next = items.filter((item) => unquote(item) !== "mcp" && !isBrokenEntry(item));
	if (name === EXPLORER) next = next.filter((item) => unquote(item) !== "codegraph");
	if (AGENTS_WITH_MCP_TOOL.has(name) && !next.some((item) => unquote(item) === CODEGRAPH_MCP_TOOL)) next.push(CODEGRAPH_MCP_TOOL);
	// An empty list would hand the agent Pi's default tools; keep what was there instead.
	if (next.length === 0 || next.join("\n") === items.join("\n")) return front;

	const replacement =
		style === "list" ? ["tools:", ...next.map((item) => `${indent}- ${item}`)]
		: style === "bracket" ? [`tools: [${next.join(", ")}]`]
		: [`tools: ${next.join(", ")}`];
	return [...lines.slice(0, at), ...replacement, ...lines.slice(at + consumed)].join(eol);
}

/** Returns the agent definition with the CodeGraph wiring applied; identical text when nothing changes. */
export function normalizeAgent(text: string): string {
	const match = FRONTMATTER.exec(text);
	if (!match) return text;
	const [, open, front, close, body] = match;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const name = /^name:\s*(.+)$/m.exec(front)?.[1];
	const cleaned = removeBlocks(body, eol);
	let rewritten = name !== undefined && unquote(name) === EXPLORER ? rewriteExplorerInstructions(cleaned, eol) : cleaned;
	if (name !== undefined && unquote(name) === "gentle-ai-worker" && !rewritten.includes(WORKER_MARKER)) {
		rewritten = rewritten.trimEnd() + eol + eol + WORKER_MARKER + eol;
	}
	return open + editTools(front, eol) + close + rewritten;
}
