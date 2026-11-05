import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { NO_PROJECT_TEXT } from "./daemonclient.ts";

/** A cold daemon on a network share can need over a minute for its first read. */
export const WARMUP_TIMEOUT_MS = 120_000;
/** Any query works: the point is that a read call makes the daemon open its database and start a worker. */
export const WARMUP_QUERY = "main";
/** The command line the warm-up runs; only tests ask for another one. */
export const WARMUP_COMMAND = "codegraph serve --mcp";

export interface ExploreOnceResult {
	/** The server answered the explore call without an error. */
	ok: boolean;
	/** How long the explore call alone took. */
	exploreMs: number;
}

/**
 * Talks MCP to `codegraph serve --mcp` in `cwd`: initialize, one `codegraph_explore`, then closes stdin and
 * lets the server go on its own. The project daemon is shared with the user's own sessions, so this never
 * kills the process tree (that would take the daemon with it) and gives up waiting instead; it releases the
 * server's stdout so a server that never leaves cannot keep the process alive. Never rejects.
 */
export function exploreOnce(cwd: string, query: string, timeoutMs: number, command: string = WARMUP_COMMAND): Promise<ExploreOnceResult> {
	return new Promise((resolve) => {
		let settled = false;
		let exploreStart = 0;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { child?.stdin?.end(); } catch { /* already closed */ }
			// The server may never leave on its own: its piped stdout would keep the event loop of Pi alive.
			try { child?.stdout?.destroy(); } catch { /* already gone */ }
			child?.unref();
			resolve({ ok, exploreMs: exploreStart === 0 ? 0 : Date.now() - exploreStart });
		};
		let child: ReturnType<typeof spawn> | undefined;
		const timer = setTimeout(() => finish(false), timeoutMs);
		try {
			// Windows needs a shell for the .cmd shim; the default command line is fixed and nothing user-controlled goes into it.
			child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			finish(false);
			return;
		}
		const send = (message: object) => child?.stdin?.write(JSON.stringify(message) + "\n");
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				let message: { id?: number; error?: unknown; result?: { isError?: boolean; content?: { text?: string }[] } };
				try { message = JSON.parse(line); } catch { continue; }
				if (message.id === 1) {
					send({ jsonrpc: "2.0", method: "notifications/initialized" });
					exploreStart = Date.now();
					send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codegraph_explore", arguments: { query } } });
				} else if (message.id === 2) {
					// CodeGraph reports a crashed query worker with isError and a text, not with a JSON-RPC error.
					const text = message.result?.content?.[0]?.text;
					const failed = message.error !== undefined || message.result?.isError === true;
					finish(!failed && typeof text === "string" && !text.startsWith(NO_PROJECT_TEXT));
				}
			}
		});
		child.on("error", () => finish(false));
		child.on("close", () => finish(false));
		child.stdin?.on("error", () => { /* the server exited first */ });
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gentle-shell-codegraph-subagents", version: "0" }, rootUri: pathToFileURL(cwd).href },
		});
	});
}

/** Makes the project's CodeGraph daemon open its database and start a read worker, so the next real call is fast. */
export async function warmUpDaemon(cwd: string, timeoutMs: number = WARMUP_TIMEOUT_MS): Promise<boolean> {
	return (await exploreOnce(cwd, WARMUP_QUERY, timeoutMs)).ok;
}
