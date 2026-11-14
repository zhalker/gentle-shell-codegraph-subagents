export const CODEGRAPH_MCP_TOOL = "mcp__codegraph__codegraph_explore";

/** The native CodeGraph extension tool: the one that can `init`, `query` and `explore` itself. */
export const NATIVE_CODEGRAPH_TOOL = "codegraph";

/** The marker an older version of this package appended to a worker agent body; the repair recognises it. */
export const WORKER_MARKER = "<!-- codegraph-workflow:worker -->";

/** gentle-pi marks a subagent child with this variable and puts the tool list it requested in the other one. */
export const CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";
export const REQUESTED_TOOLS_ENV = "GENTLE_PI_AGENTS_REQUESTED_TOOLS";

/**
 * gentle-pi hands a child its agent body as `<tmpdir>/gentle-pi-subagent-<agent>-<random>/instructions.md` after
 * `--append-system-prompt`, so the child's own command line is where its agent name is readable.
 */
export const SUBAGENT_DIR_PREFIX = "gentle-pi-subagent-";

/**
 * The gentle-shell agents the CodeGraph rule has a text of its own for (both judges share one). The random suffix
 * gentle-pi appends to the directory could otherwise be read as part of the name, so these names are what cuts
 * the name out; a name this list does not carry is kept as the directory spells it.
 */
export const RULE_AGENT_NAMES: readonly string[] = [
	"gentle-ai-explore",
	"gentle-ai-verify",
	"gentle-ai-worker",
	"jd-fix-agent",
	"jd-judge-a",
	"jd-judge-b",
];

/**
 * The agent name of a subagent child, read from its own argv: `undefined` in the primary session, which carries no
 * such directory. An unrecognised agent keeps the directory's spelling, so a `review-` child is still recognised by
 * its prefix. An argument that is not a string is skipped, and this never throws.
 */
export function agentNameFromArgv(argv: readonly string[] | undefined): string | undefined {
	if (!Array.isArray(argv)) return undefined;
	for (const arg of argv) {
		if (typeof arg !== "string") continue;
		const at = arg.lastIndexOf(SUBAGENT_DIR_PREFIX);
		if (at < 0) continue;
		const rest = arg.slice(at + SUBAGENT_DIR_PREFIX.length);
		const end = rest.search(/[\\/]/);
		const directory = (end < 0 ? rest : rest.slice(0, end)).trim();
		if (directory.length === 0) continue;
		for (const name of RULE_AGENT_NAMES) {
			if (directory === name || directory.startsWith(`${name}-`)) return name;
		}
		return directory;
	}
	return undefined;
}

/** Tools that write a file of the project: a role holding one of them may write the index too. */
export const FILE_WRITING_TOOLS: readonly string[] = ["edit", "write", "bash_background"];

/** Tools that run a command without writing a file through it: verify and the judges hold `bash` and stay read-only. */
export const COMMAND_TOOLS: readonly string[] = ["bash", "bash_background"];

/** CodeGraph tools among a declared tool list; the MCP wildcard stands for the explore tool. */
export function codegraphTools(tools: readonly string[]): string[] {
	const selected: string[] = [];
	if (tools.includes(NATIVE_CODEGRAPH_TOOL)) selected.push(NATIVE_CODEGRAPH_TOOL);
	if (tools.some((tool) => tool === CODEGRAPH_MCP_TOOL || tool === "mcp__codegraph__*")) selected.push(CODEGRAPH_MCP_TOOL);
	return selected;
}

/**
 * What a session may do with the project's index, read from the tool list gentle-pi requested for it (a subagent
 * child carries no agent name, only that list). The explorer reads only; verify and the judges read and run
 * commands but write no file, and they never initiate an `init` or a `sync`; a worker or the main session may.
 */
export type IndexRole =
	/** Reads only and holds a CodeGraph tool: the explorer. */
	| "explorer"
	/** Reads and runs commands but writes no file: verify and the judges. */
	| "read-only"
	/** Can write the project. */
	| "writer"
	/** The list says nothing about CodeGraph. */
	| "unknown";

/** The tool list gentle-pi requested for a child, as one array; empty for the main session. */
export function requestedTools(env: Record<string, string | undefined>): string[] {
	return (env[REQUESTED_TOOLS_ENV] ?? "").split(",").map((tool) => tool.trim()).filter((tool) => tool.length > 0);
}

/** The role of one declared tool list. A file-writing tool wins, then a command tool, then a CodeGraph tool. */
export function indexRole(tools: readonly string[]): IndexRole {
	if (tools.length === 0) return "unknown";
	if (tools.some((tool) => FILE_WRITING_TOOLS.includes(tool))) return "writer";
	if (tools.some((tool) => COMMAND_TOOLS.includes(tool))) return "read-only";
	return codegraphTools(tools).length > 0 ? "explorer" : "unknown";
}

/** The role of this session: undefined in the main session, which is not a subagent role. */
export function sessionIndexRole(env: Record<string, string | undefined>): IndexRole | undefined {
	return env[CHILD_ENV] === "1" ? indexRole(requestedTools(env)) : undefined;
}

/** Whether this role may start an index write at all. A read-only role (verify, the judges) may not. */
export function mayInitiateIndexWrite(role: IndexRole | undefined): boolean {
	return role !== "read-only";
}
