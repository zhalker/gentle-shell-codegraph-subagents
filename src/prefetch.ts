import { spawn } from "node:child_process";
import { join } from "node:path";
import { CODEGRAPH_MCP_TOOL } from "./agents.ts";
import type { DaemonExploreResult } from "./daemonclient.ts";

export const PREFETCH_MAX_CHARS = 12_000;
export const QUERY_MAX_CHARS = 300;

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

export function killTree(pid: number | undefined, child: { kill(): boolean }): void {
	if (process.platform === "win32" && pid !== undefined) {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
			return;
		} catch { /* fall through */ }
	}
	try { child.kill(); } catch { /* already gone */ }
}

/**
 * A warm daemon answers in about 0.5-2 s; 10 s leaves room for the slowest one seen, a real prefetch on a
 * network share that answered in 8375 ms. The CLI is not a fallback: it opens the index in its own
 * process every time (2.5-6 s on SMB) and starts no daemon, so it would warm nothing.
 */
export const DAEMON_PREFETCH_TIMEOUT_MS = 10_000;

export type PerCaseOutcome = "ok" | "daemon-timeout" | "daemon-error" | "skipped-no-daemon" | "empty";

export interface PerCaseDeps {
	daemon(query: string, cwd: string, timeoutMs: number): Promise<DaemonExploreResult>;
	/** Starts the project daemon; called without waiting for it. */
	warm(cwd: string): Promise<unknown>;
}

/**
 * A live daemon is asked with {@link DAEMON_PREFETCH_TIMEOUT_MS}. With no usable daemon the explorer does not
 * wait at all: the CLI is not run, and the warm-up starts in the background so the next explorer finds the
 * daemon warm. Never rejects.
 */
export async function explorePerCase(query: string, cwd: string, deps: PerCaseDeps): Promise<{ text: string | undefined; outcome: PerCaseOutcome }> {
	let result: DaemonExploreResult | undefined;
	let threw = false;
	try {
		result = await deps.daemon(query, cwd, DAEMON_PREFETCH_TIMEOUT_MS);
	} catch {
		// Anything unexpected in the daemon path is logged apart from a missing daemon, and treated the same.
		threw = true;
		result = undefined;
	}
	if (result?.status === "ok") {
		return result.text.trim().length > 0 ? { text: result.text, outcome: "ok" } : { text: undefined, outcome: "empty" };
	}
	// Too slow: the daemon is up and busy, so warming it again would only add a second slower attempt.
	if (result?.status === "timeout") return { text: undefined, outcome: "daemon-timeout" };
	try {
		deps.warm(cwd).catch(() => { /* a failed warm-up only means the next explorer waits for nothing too */ });
	} catch {
		// Same: never worth failing the prompt.
	}
	return { text: undefined, outcome: threw ? "daemon-error" : "skipped-no-daemon" };
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
		// A read call while an init builds the index can hang that init for good, so this waits for the next run.
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
