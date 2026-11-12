export const CODEGRAPH_MCP_TOOL = "mcp__codegraph__codegraph_explore";

const AGENTS_WITH_MCP_TOOL = new Set([
	"gentle-ai-explore",
	"gentle-ai-verify",
	"gentle-ai-worker",
	"jd-fix-agent",
	"jd-judge-a",
	"jd-judge-b",
]);

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/;
const BLOCK_PATTERN = "<!-- gentle-ai:pi-codegraph-(?:tool|guidance) -->[\\s\\S]*?<!-- \\/gentle-ai:pi-codegraph -->";
const GENTLE_AI_BLOCK = new RegExp(BLOCK_PATTERN, "g");
// The markers make gentle-ai's blocks visible without depending on the rest of the file.
const HAS_GENTLE_AI_BLOCK = new RegExp(BLOCK_PATTERN);
const MARKER = "\u0000";

function unquote(value: string): string {
	const v = value.trim();
	return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
}

// The gentle-pi agent files ship a `- "*": false` list entry; Pi reads it as a tool named `*": false`.
function isBrokenEntry(item: string): boolean {
	return /\*["']?\s*:\s*false/.test(item);
}

function removeBlocks(body: string, eol: string): string {
	if (!body.includes("gentle-ai:pi-codegraph")) return body;
	const marked = body.replace(GENTLE_AI_BLOCK, MARKER);
	return marked.replace(/\s*\u0000(?:\s*\u0000)*\s*/g, (match, offset: number) => {
		if (offset === 0) return "";
		return offset + match.length >= marked.length ? eol : eol + eol;
	});
}


interface ParsedTools {
	lines: string[];
	at: number;
	style: "bracket" | "csv" | "list";
	items: string[];
	consumed: number;
	indent: string;
	name: string;
}

function parseTools(front: string): ParsedTools | undefined {
	const lines = front.split(/\r?\n/);
	const nameLine = lines.find((line) => /^name:/.test(line));
	const name = nameLine ? unquote(nameLine.slice("name:".length)) : "";
	const at = lines.findIndex((line) => /^tools:/.test(line));
	if (at === -1) return undefined;
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
	return { lines, at, style, items, consumed, indent, name };
}

function renderTools(parsed: ParsedTools, next: string[], eol: string): string {
	const replacement =
		parsed.style === "list" ? ["tools:", ...next.map((item) => `${parsed.indent}- ${item}`)]
		: parsed.style === "bracket" ? [`tools: [${next.join(", ")}]`]
		: [`tools: ${next.join(", ")}`];
	return [...parsed.lines.slice(0, parsed.at), ...replacement, ...parsed.lines.slice(parsed.at + parsed.consumed)].join(eol);
}

function editTools(front: string, eol: string): string {
	const parsed = parseTools(front);
	if (!parsed) return front;
	const { style, items } = parsed;
	if (items.length === 0) return front;
	let next = items.filter((item) => unquote(item) !== "mcp" && !isBrokenEntry(item));
	if (AGENTS_WITH_MCP_TOOL.has(parsed.name) && !next.some((item) => unquote(item) === CODEGRAPH_MCP_TOOL)) next.push(CODEGRAPH_MCP_TOOL);
	// An empty list would hand the agent Pi's default tools; keep what was there instead.
	if (next.length === 0 || next.join("\n") === items.join("\n")) return front;
	return renderTools(parsed, next, eol);
}

/**
 * The block-free path: for the six agents, add the CodeGraph MCP tool when it is missing — and only that.
 * Nothing else changes: dead proxy entries and broken `"*": false` entries stay, because this file may be
 * one gentle-pi still manages and the owner asked for the minimal edit that makes the tool available.
 */
function addMissingMcpTool(front: string, eol: string): string {
	const parsed = parseTools(front);
	if (!parsed) return front;
	if (!AGENTS_WITH_MCP_TOOL.has(parsed.name)) return front;
	if (parsed.items.length === 0) return front;
	if (parsed.items.some((item) => unquote(item) === CODEGRAPH_MCP_TOOL)) return front;
	return renderTools(parsed, [...parsed.items, CODEGRAPH_MCP_TOOL], eol);
}

/**
 * Returns the agent definition with the CodeGraph wiring applied; identical text when nothing changes.
 * A file that still carries the gentle-ai marker blocks is normalized the old way (blocks and dead proxy
 * entries removed, tool added). A block-free file — a gentle-pi-managed agent, a standalone install, or one
 * the user edited — gets exactly one minimal edit: for the six agents, the CodeGraph MCP tool is appended
 * when missing. The owner accepted that this single-line edit freezes the agent's file at its current
 * version for gentle-pi's installer (any local edit does), because the alternative is subagents without
 * CodeGraph at all; the first-rewrite backup keeps the pre-edit bytes.
 */
export function normalizeAgent(text: string): string {
	const match = FRONTMATTER.exec(text);
	if (!match) return text;
	const [, open, front, close, body] = match;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	if (!HAS_GENTLE_AI_BLOCK.test(text)) {
		const next = addMissingMcpTool(front, eol);
		return next === front ? text : open + next + close + body;
	}
	return open + editTools(front, eol) + close + removeBlocks(body, eol);
}
