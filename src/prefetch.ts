import { spawn } from "node:child_process";
import { join } from "node:path";
import { CODEGRAPH_MCP_TOOL } from "./agents.ts";
import type { DaemonExploreResult } from "./daemonclient.ts";

export const PREFETCH_TIMEOUT_MS = 20_000;
export const PREFETCH_MAX_CHARS = 12_000;
export const QUERY_MAX_CHARS = 300;
const READ_LIMIT_BYTES = 200_000;

const REQUESTED_TOOLS_ENV = "GENTLE_PI_AGENTS_REQUESTED_TOOLS";
const CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";
const WRITING_TOOLS = ["bash", "edit", "write", "bash_background"];

/**
 * gentle-pi gives a subagent child no env var with the agent's name, only its tool list.
 * The explorer is the one child that reads only and holds the CodeGraph MCP tool.
 */
export function isExplorerChild(env: Record<string, string | undefined>): boolean {
	if (env[CHILD_ENV] !== "1") return false;
	const tools = (env[REQUESTED_TOOLS_ENV] ?? "").split(",").map((tool) => tool.trim());
	return tools.includes(CODEGRAPH_MCP_TOOL) && !tools.some((tool) => WRITING_TOOLS.includes(tool));
}

/**
 * The task text becomes arguments of a command that Windows runs through cmd.exe, so only
 * letters, digits and a few harmless marks survive, and no word can look like an option.
 */
export function sanitizeQuery(task: string): string {
	const words = task
		.replace(/[^\p{L}\p{N}_.,:/-]+/gu, " ")
		.split(" ")
		.map((word) => word.replace(/^-+/, ""))
		.filter((word) => word.length > 0);
	return words.join(" ").slice(0, QUERY_MAX_CHARS).trim();
}

export function boundOutput(text: string, max = PREFETCH_MAX_CHARS): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n\n[truncated: output cut at ${max} characters]`;
}

export interface RunOptions {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	maxBytes: number;
	/** Windows needs a shell to run the .cmd shim that npm installs for codegraph. */
	shell?: boolean;
}

export function killTree(pid: number | undefined, child: { kill(): boolean }): void {
	if (process.platform === "win32" && pid !== undefined) {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
			return;
		} catch { /* fall through */ }
	}
	try { child.kill(); } catch { /* already gone */ }
}

/** Output of a command that exits 0 and prints something; undefined for anything else. Never rejects. */
export function runCommand(options: RunOptions): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		let child;
		try {
			child = options.shell
				? spawn([options.command, ...options.args].join(" "), { cwd: options.cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
				: spawn(options.command, options.args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			resolve(undefined);
			return;
		}
		const timer = setTimeout(() => {
			killTree(child.pid, child);
			finish(undefined);
		}, options.timeoutMs);
		const chunks: Buffer[] = [];
		let size = 0;
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > options.maxBytes) {
				killTree(child.pid, child);
				finish(Buffer.concat(chunks).toString("utf8").slice(0, options.maxBytes));
				return;
			}
			chunks.push(chunk);
		});
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			const text = Buffer.concat(chunks).toString("utf8");
			finish(code === 0 && text.trim().length > 0 ? text : undefined);
		});
	});
}

/** The CLI's explore output is the same as the codegraph_explore MCP tool. */
export function exploreWithCodegraph(query: string, cwd: string): Promise<string | undefined> {
	const windows = process.platform === "win32";
	return runCommand({
		command: "codegraph",
		args: windows ? ["explore", ...query.split(" ")] : ["explore", query],
		cwd,
		timeoutMs: PREFETCH_TIMEOUT_MS,
		maxBytes: READ_LIMIT_BYTES,
		shell: windows,
	});
}

export interface DaemonFirstDeps {
	daemon(query: string, cwd: string): Promise<DaemonExploreResult>;
	cli(query: string, cwd: string): Promise<string | undefined>;
}

/**
 * Asks the project daemon first; only when there is no usable one does the CLI answer, as it always did.
 * A daemon that was there but too slow is not retried through the CLI, which would be slower still.
 */
export async function exploreDaemonFirst(query: string, cwd: string, deps: DaemonFirstDeps): Promise<string | undefined> {
	try {
		const result = await deps.daemon(query, cwd);
		if (result.status === "ok") return result.text;
		if (result.status === "timeout") return undefined;
	} catch {
		// Anything unexpected in the daemon path means the CLI takes over.
	}
	return deps.cli(query, cwd);
}

export interface PrefetchInput {
	env: Record<string, string | undefined>;
	prompt: string | undefined;
	cwd: string;
	exists(path: string): boolean;
	/** Whether another session is creating the index of this cwd; nothing may touch it meanwhile. */
	initRunning?(cwd: string): boolean;
	explore(query: string, cwd: string): Promise<string | undefined>;
}

/** Text to hand to the explorer before its first step; undefined means the run goes on untouched. */
export async function prefetchForExplorer(input: PrefetchInput): Promise<string | undefined> {
	try {
		if (!isExplorerChild(input.env) || input.prompt === undefined) return undefined;
		const query = sanitizeQuery(input.prompt);
		if (query.length === 0) return undefined;
		if (!input.exists(join(input.cwd, ".codegraph"))) return undefined;
		// A daemon or CLI call while an init builds the index can hang that init for good, so this waits for the next run.
		if (input.initRunning?.(input.cwd)) return undefined;
		const output = await input.explore(query, input.cwd);
		if (output === undefined || output.trim().length === 0) return undefined;
		return [
			"CodeGraph pre-fetch for your task, run for you before your first step with `codegraph explore` (bounded in size and time).",
			`Use it as a starting point and call ${CODEGRAPH_MCP_TOOL} when you need more.`,
			"",
			boundOutput(output.trim()),
		].join("\n");
	} catch {
		return undefined;
	}
}
