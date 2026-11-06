import net from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalRoot } from "./paths.ts";

/** The hello line a CodeGraph daemon sends carries `protocol`; this is the only one spoken here. */
export const DAEMON_PROTOCOL = 1;
/** An explore answer is tens of kilobytes; anything near this size is not one worth keeping in memory. */
export const MAX_REPLY_CHARS = 1_000_000;
/** CodeGraph answers an explore without a project with this plain text, not with an error. */
export const NO_PROJECT_TEXT = "No CodeGraph project is loaded";

export type DaemonExploreResult =
	| { status: "ok"; text: string }
	/** No daemon to ask, or it did not behave as expected: the caller should use another way. */
	| { status: "unavailable" }
	/** A daemon was there but did not answer in time: a second attempt would only be slower. */
	| { status: "timeout" };

export interface DaemonOptions {
	/** Where daemons register themselves; defaults to `~/.codegraph/daemons`. */
	registryDir?: string;
}

/**
 * The same project can be spelled with another letter case or a trailing separator, and on Windows as a
 * mapped drive (Y:\...) or as the UNC path behind it (\\server\share\...). One
 * canonical form for every root comparison (see paths.ts); kept under this name for its callers.
 */
export const normalizeRoot = (path: string): string => canonicalRoot(path);

const DEFAULT_REGISTRY = () => join(homedir(), ".codegraph", "daemons");

interface RegisteredDaemon {
	root: string;
	socketPath: string;
	startedAt: number;
	pid?: number;
}

/** Whether a process with this pid exists; signal 0 only checks. EPERM means it exists under another user. */
function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Daemons registered for `root` in any spelling, newest first. Reads the registry only; starts nothing. */
function daemonsFor(root: string, registryDir: string): RegisteredDaemon[] {
	let files: string[];
	try { files = readdirSync(registryDir).filter((file) => file.endsWith(".json")); } catch { return []; }
	const wanted = normalizeRoot(root);
	const found: RegisteredDaemon[] = [];
	for (const file of files) {
		try {
			const entry = JSON.parse(readFileSync(join(registryDir, file), "utf8"));
			if (typeof entry.root !== "string" || typeof entry.socketPath !== "string") continue;
			if (normalizeRoot(entry.root) !== wanted) continue;
			found.push({
				root: entry.root,
				socketPath: entry.socketPath,
				startedAt: typeof entry.startedAt === "number" ? entry.startedAt : 0,
				pid: typeof entry.pid === "number" ? entry.pid : undefined,
			});
		} catch { /* a damaged record is not a daemon */ }
	}
	return found.sort((a, b) => b.startedAt - a.startedAt);
}

/** Named pipes of the daemons registered for `root`, newest first. */
function socketsFor(root: string, registryDir: string): string[] {
	return daemonsFor(root, registryDir).map((entry) => entry.socketPath);
}

/**
 * How the newest daemon of this project spells its root, or undefined when none is registered. Passing that
 * spelling to codegraph keeps it on the same daemon: CodeGraph keys daemons by the path it was given, and
 * W:\project next to w:\project already runs two daemons for one project on this machine.
 */
export function registeredRoot(root: string, registryDir: string = DEFAULT_REGISTRY()): string | undefined {
	const daemons = daemonsFor(root, registryDir);
	// Dead records stay in the registry; the spelling of a live daemon keeps codegraph on that daemon.
	const alive = daemons.find((entry) => entry.pid !== undefined && processAlive(entry.pid));
	return (alive ?? daemons[0])?.root;
}

/** The path to hand to the codegraph CLI for this project: the registered spelling when there is one. */
export function projectArgument(root: string, registryDir?: string): string {
	return registeredRoot(root, registryDir) ?? root;
}

/** One conversation with one daemon: hello, initialize, one codegraph_explore. */
function ask(socketPath: string, query: string, timeoutMs: number): Promise<DaemonExploreResult> {
	return new Promise((resolveResult) => {
		let settled = false;
		const socket = net.createConnection(socketPath);
		const finish = (result: DaemonExploreResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolveResult(result);
		};
		const timer = setTimeout(() => finish({ status: "timeout" }), Math.max(1, timeoutMs));
		const send = (message: object) => socket.write(JSON.stringify(message) + "\n");
		let buffer = "";
		let stage: "hello" | "initialize" | "explore" = "hello";
		socket.setEncoding("utf8");
		socket.on("error", () => finish({ status: "unavailable" }));
		socket.on("close", () => finish({ status: "unavailable" }));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_REPLY_CHARS) return finish({ status: "unavailable" });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				let message: any;
				try { message = JSON.parse(line); } catch { return finish({ status: "unavailable" }); }
				if (stage === "hello") {
					if (typeof message.codegraph !== "string" || message.protocol !== DAEMON_PROTOCOL) return finish({ status: "unavailable" });
					stage = "initialize";
					send({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gentle-shell-codegraph-subagents", version: "0" } },
					});
				} else if (stage === "initialize" && message.id === 1) {
					if (message.error !== undefined) return finish({ status: "unavailable" });
					stage = "explore";
					send({ jsonrpc: "2.0", method: "notifications/initialized" });
					send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codegraph_explore", arguments: { query } } });
				} else if (stage === "explore" && message.id === 2) {
					// CodeGraph reports a crashed query worker with isError and a text, not with a JSON-RPC error.
					const text = message.result?.content?.[0]?.text;
					const failed = message.error !== undefined || message.result?.isError === true;
					if (failed || typeof text !== "string" || text.startsWith(NO_PROJECT_TEXT)) return finish({ status: "unavailable" });
					return finish({ status: "ok", text });
				}
			}
		});
	});
}

/**
 * Runs `codegraph_explore` through the daemon already serving `root`, the same text the CLI prints but without
 * a process of its own. It only reads the daemon registry and connects: it never starts a daemon, and never
 * throws.
 */
export async function exploreViaDaemon(root: string, query: string, timeoutMs: number, options: DaemonOptions = {}): Promise<DaemonExploreResult> {
	try {
		const registryDir = options.registryDir ?? DEFAULT_REGISTRY();
		const deadline = Date.now() + timeoutMs;
		for (const socketPath of socketsFor(root, registryDir)) {
			const result = await ask(socketPath, query, deadline - Date.now());
			if (result.status !== "unavailable") return result;
		}
		return { status: "unavailable" };
	} catch {
		return { status: "unavailable" };
	}
}
