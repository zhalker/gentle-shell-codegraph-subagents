import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exploreViaDaemon } from "../src/daemonclient.ts";
import { exploreDaemonFirst, exploreWithCodegraph, prefetchForExplorer } from "../src/prefetch.ts";
import { warmUpDaemon } from "../src/warmup.ts";
import { daemonPids, hasCodegraph, indexedProject, stopDaemon } from "./helpers.ts";

// --- A fake daemon on a real named pipe: tests the protocol and every failure without CodeGraph. ---

let counter = 0;
function pipePath(): string {
	const name = `pcs-test-${process.pid}-${++counter}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

const HELLO = JSON.stringify({ codegraph: "1.6.0", pid: process.pid, socketPath: "x", protocol: 1 });

interface FakeOptions {
	/** First line the daemon sends; null sends nothing. */
	hello?: string | null;
	/** What to do with the explore call. */
	explore?: { text: string; isError?: boolean } | { error: string } | "silence" | { split: string } | { closeAfterHello: true };
	received?: string[];
}

function fakeDaemon(options: FakeOptions): Promise<{ path: string; close(): void }> {
	const path = pipePath();
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		if (options.hello !== null) socket.write((options.hello ?? HELLO) + "\n");
		const explore = options.explore ?? { text: "FAKE EXPLORE OUTPUT" };
		if (typeof explore === "object" && "closeAfterHello" in explore) {
			socket.end();
			return;
		}
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				options.received?.push(line);
				const message = JSON.parse(line);
				if (message.method === "initialize") {
					socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");
				} else if (message.method === "tools/call") {
					if (explore === "silence") continue;
					if ("error" in explore) {
						socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: explore.error } }) + "\n");
					} else if ("split" in explore) {
						const full = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: explore.split }] } }) + "\n";
						socket.write(full.slice(0, 10));
						setTimeout(() => socket.write(full.slice(10)), 30);
					} else {
						const result = explore.isError === true
							? { isError: true, content: [{ type: "text", text: explore.text }] }
							: { content: [{ type: "text", text: explore.text }] };
						socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
					}
				}
			}
		});
	});
	return new Promise((resolve) => server.listen(path, () => resolve({ path, close: () => server.close() })));
}

function registry(entries: { root: string; socketPath: string; startedAt?: number }[]): string {
	const dir = mkdtempSync(join(tmpdir(), "pcs-registry-"));
	entries.forEach((entry, index) => {
		writeFileSync(join(dir, `entry${index}.json`), JSON.stringify({ root: entry.root, pid: process.pid, version: "1.6.0", socketPath: entry.socketPath, startedAt: entry.startedAt ?? Date.now() }));
	});
	return dir;
}

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "pcs-root-")));

test("S15: asks the daemon registered for the project and returns its text", async () => {
	const received: string[] = [];
	const daemon = await fakeDaemon({ received });
	try {
		const result = await exploreViaDaemon(ROOT, "coapi login flow", 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
		assert.deepEqual(result, { status: "ok", text: "FAKE EXPLORE OUTPUT" });
		const call = JSON.parse(received.find((line) => line.includes("tools/call"))!);
		assert.equal(call.params.name, "codegraph_explore");
		assert.deepEqual(call.params.arguments, { query: "coapi login flow" });
	} finally {
		daemon.close();
	}
});

test("S15: a reply that arrives in pieces is put back together", async () => {
	const daemon = await fakeDaemon({ explore: { split: "SPLIT OUTPUT" } });
	try {
		const result = await exploreViaDaemon(ROOT, "q", 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
		assert.deepEqual(result, { status: "ok", text: "SPLIT OUTPUT" });
	} finally {
		daemon.close();
	}
});

test("S15: a hello with another protocol is refused before anything else is said", async () => {
	const received: string[] = [];
	const daemon = await fakeDaemon({ hello: JSON.stringify({ codegraph: "9.9.9", pid: 1, protocol: 2 }), received });
	try {
		const result = await exploreViaDaemon(ROOT, "q", 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
		assert.deepEqual(result, { status: "unavailable" });
		assert.deepEqual(received, []);
	} finally {
		daemon.close();
	}
});

test("S15: a hello that is not JSON, lacks fields, or never comes means unavailable or timeout, never a throw", async () => {
	for (const hello of ["not json", JSON.stringify({ protocol: 1 })]) {
		const daemon = await fakeDaemon({ hello });
		try {
			const result = await exploreViaDaemon(ROOT, "q", 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
			assert.deepEqual(result, { status: "unavailable" }, hello);
		} finally {
			daemon.close();
		}
	}
});

test("S15: a daemon that hangs up right after the hello is unavailable", async () => {
	const daemon = await fakeDaemon({ explore: { closeAfterHello: true } });
	try {
		assert.deepEqual(await exploreViaDaemon(ROOT, "q", 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) }), { status: "unavailable" });
	} finally {
		daemon.close();
	}
});

test("S15: an error reply, or CodeGraph's 'no project' text, is unavailable", async () => {
	for (const explore of [{ error: "boom" }, { text: "No CodeGraph project is loaded for this session." }]) {
		const daemon = await fakeDaemon({ explore });
		try {
			const result = await exploreViaDaemon(ROOT, "q", 5_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
			assert.deepEqual(result, { status: "unavailable" }, JSON.stringify(explore));
		} finally {
			daemon.close();
		}
	}
});

test("S18: an MCP reply with isError is unavailable, so the CLI answers instead of the explorer", async () => {
	// CodeGraph answers a crashed query worker this way: a text result, flagged as an error.
	const daemon = await fakeDaemon({ explore: { text: "codegraph worker crashed; please retry the call.", isError: true } });
	try {
		const registryDir = registry([{ root: ROOT, socketPath: daemon.path }]);
		assert.deepEqual(await exploreViaDaemon(ROOT, "q", 5_000, { registryDir }), { status: "unavailable" });
		const text = await exploreDaemonFirst("q", ROOT, { daemon: (query, cwd) => exploreViaDaemon(cwd, query, 5_000, { registryDir }), cli: async () => "FROM CLI" });
		assert.equal(text, "FROM CLI");
	} finally {
		daemon.close();
	}
});

test("S15: output beyond the cap is unavailable, so the CLI answers instead of memory growing", async () => {
	const daemon = await fakeDaemon({ explore: { text: "x".repeat(1_500_000) } });
	try {
		assert.deepEqual(await exploreViaDaemon(ROOT, "q", 10_000, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) }), { status: "unavailable" });
	} finally {
		daemon.close();
	}
});

test("S15: a daemon that never answers is a timeout, reported on time", async () => {
	const daemon = await fakeDaemon({ explore: "silence" });
	try {
		const started = Date.now();
		const result = await exploreViaDaemon(ROOT, "q", 400, { registryDir: registry([{ root: ROOT, socketPath: daemon.path }]) });
		assert.deepEqual(result, { status: "timeout" });
		assert.ok(Date.now() - started < 3_000);
	} finally {
		daemon.close();
	}
});

test("S15: no registry, an empty one, or another project's daemon is unavailable", async () => {
	const daemon = await fakeDaemon({});
	try {
		const other = realpathSync(mkdtempSync(join(tmpdir(), "pcs-other-")));
		assert.deepEqual(await exploreViaDaemon(ROOT, "q", 2_000, { registryDir: join(tmpdir(), "pcs-does-not-exist") }), { status: "unavailable" });
		assert.deepEqual(await exploreViaDaemon(ROOT, "q", 2_000, { registryDir: registry([]) }), { status: "unavailable" });
		assert.deepEqual(await exploreViaDaemon(ROOT, "q", 2_000, { registryDir: registry([{ root: other, socketPath: daemon.path }]) }), { status: "unavailable" });
	} finally {
		daemon.close();
	}
});

test("S15: a registry entry whose daemon is gone is unavailable; with several entries a live one is still found", async () => {
	const dead = pipePath();
	assert.deepEqual(await exploreViaDaemon(ROOT, "q", 2_000, { registryDir: registry([{ root: ROOT, socketPath: dead }]) }), { status: "unavailable" });
	const live = await fakeDaemon({});
	try {
		for (const entries of [
			[{ root: ROOT, socketPath: dead, startedAt: 2 }, { root: ROOT, socketPath: live.path, startedAt: 1 }],
			[{ root: ROOT, socketPath: live.path, startedAt: 2 }, { root: ROOT, socketPath: dead, startedAt: 1 }],
		]) {
			const result = await exploreViaDaemon(ROOT, "q", 5_000, { registryDir: registry(entries) });
			assert.equal(result.status, "ok");
		}
	} finally {
		live.close();
	}
});

test("S15: the project root matches whatever its spelling: trailing separator and, on Windows, letter case", async () => {
	const daemon = await fakeDaemon({});
	try {
		const spellings = [ROOT + (process.platform === "win32" ? "\\" : "/"), ...(process.platform === "win32" ? [ROOT.toUpperCase(), ROOT.toLowerCase()] : [])];
		for (const spelling of spellings) {
			const result = await exploreViaDaemon(ROOT, "q", 5_000, { registryDir: registry([{ root: spelling, socketPath: daemon.path }]) });
			assert.equal(result.status, "ok", spelling);
		}
	} finally {
		daemon.close();
	}
});

// --- The daemon-first composition used by the prefetch ---

test("S15: daemon first: its text is used and the CLI is never started", async () => {
	let cliCalls = 0;
	const text = await exploreDaemonFirst("q", ROOT, {
		daemon: async () => ({ status: "ok", text: "FROM DAEMON" }),
		cli: async () => { cliCalls++; return "FROM CLI"; },
	});
	assert.equal(text, "FROM DAEMON");
	assert.equal(cliCalls, 0);
});

test("S15: no usable daemon -> the CLI answers, exactly as before", async () => {
	const text = await exploreDaemonFirst("q", ROOT, { daemon: async () => ({ status: "unavailable" }), cli: async () => "FROM CLI" });
	assert.equal(text, "FROM CLI");
});

test("S15: a daemon timeout does not start a second, slower attempt through the CLI", async () => {
	let cliCalls = 0;
	const text = await exploreDaemonFirst("q", ROOT, { daemon: async () => ({ status: "timeout" }), cli: async () => { cliCalls++; return "FROM CLI"; } });
	assert.equal(text, undefined);
	assert.equal(cliCalls, 0);
});

test("S15: a throwing daemon client falls back to the CLI", async () => {
	const text = await exploreDaemonFirst("q", ROOT, { daemon: async () => { throw new Error("boom"); }, cli: async () => "FROM CLI" });
	assert.equal(text, "FROM CLI");
});

// --- Against the real CodeGraph ---

const norm = (text: string | undefined) => (text ?? "").replace(/\r\n/g, "\n").trim();
const timed = async <T>(run: () => Promise<T>) => {
	const started = Date.now();
	const value = await run();
	return { value, ms: Date.now() - started };
};

test("S15 real: with the daemon alive, the pipe answers with the same text as the CLI, and faster", { skip: !hasCodegraph }, async () => {
	const dir = indexedProject();
	try {
		stopDaemon(dir);
		assert.equal(await warmUpDaemon(dir), true);
		const cli = await timed(() => exploreWithCodegraph("warmFn1 run", dir));
		const direct = await timed(() => exploreViaDaemon(dir, "warmFn1 run", 20_000));
		assert.equal(direct.value.status, "ok");
		assert.equal(norm((direct.value as { text: string }).text), norm(cli.value));
		assert.ok(direct.ms < cli.ms * 0.6, `cli ${cli.ms} ms, direct ${direct.ms} ms`);
	} finally {
		stopDaemon(dir);
	}
});

test("S15 real: with no daemon it is unavailable and it does not start one", { skip: !hasCodegraph }, async () => {
	const dir = indexedProject();
	try {
		stopDaemon(dir);
		assert.deepEqual(await exploreViaDaemon(dir, "warmFn1 run", 20_000), { status: "unavailable" });
		assert.equal(daemonPids(dir).length, 0);
	} finally {
		stopDaemon(dir);
	}
});

test("S15 real: the explorer's prefetch gets the same content with or without a daemon, and starts no daemon", { skip: !hasCodegraph }, async () => {
	const dir = indexedProject();
	const input = {
		env: { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_REQUESTED_TOOLS: "read,grep,mcp__codegraph__codegraph_explore" },
		prompt: "warmFn1 run",
		cwd: dir,
		exists: existsSync,
		explore: (query: string, cwd: string) => exploreDaemonFirst(query, cwd, { daemon: (q, c) => exploreViaDaemon(c, q, 20_000), cli: exploreWithCodegraph }),
	};
	try {
		stopDaemon(dir);
		const withoutDaemon = await prefetchForExplorer(input);
		assert.equal(daemonPids(dir).length, 0, "the fallback must not start a daemon");
		assert.equal(await warmUpDaemon(dir), true);
		const withDaemon = await prefetchForExplorer(input);
		assert.ok(withoutDaemon && withDaemon);
		assert.match(withDaemon, /warmFn1/);
		assert.equal(norm(withDaemon), norm(withoutDaemon));
	} finally {
		stopDaemon(dir);
	}
});
