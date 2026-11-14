import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_HELLO_TIMEOUT_MS, daemonStatus, exploreViaDaemon, liveDaemon, registeredRoot } from "../src/daemonclient.ts";
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

test("S18: an MCP reply with isError is unavailable, so its text is never used as prefetch text", async () => {
	// CodeGraph answers a crashed query worker this way: a text result, flagged as an error.
	const daemon = await fakeDaemon({ explore: { text: "codegraph worker crashed; please retry the call.", isError: true } });
	try {
		const registryDir = registry([{ root: ROOT, socketPath: daemon.path }]);
		assert.deepEqual(await exploreViaDaemon(ROOT, "q", 5_000, { registryDir }), { status: "unavailable" });
	} finally {
		daemon.close();
	}
});

test("S15: output beyond the cap is unavailable, so nothing is prefetched instead of memory growing", async () => {
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

test("S15: a daemon that never says hello gives way to the next one instead of using the whole budget", async () => {
	const silent = await fakeDaemon({ hello: null });
	const live = await fakeDaemon({});
	try {
		const started = Date.now();
		const result = await exploreViaDaemon(ROOT, "q", 10_000, { registryDir: registry([
			{ root: ROOT, socketPath: silent.path, startedAt: 2 },
			{ root: ROOT, socketPath: live.path, startedAt: 1 },
		]) });
		assert.deepEqual(result, { status: "ok", text: "FAKE EXPLORE OUTPUT" });
		assert.ok(Date.now() - started < DAEMON_HELLO_TIMEOUT_MS + 2_000, `took ${Date.now() - started} ms`);
	} finally {
		silent.close();
		live.close();
	}
});

test("S15: when the only daemon never says hello, it is a timeout reported after the hello wait, not after the whole budget", async () => {
	const silent = await fakeDaemon({ hello: null });
	try {
		const started = Date.now();
		const result = await exploreViaDaemon(ROOT, "q", 10_000, { registryDir: registry([{ root: ROOT, socketPath: silent.path }]) });
		assert.deepEqual(result, { status: "timeout" });
		const took = Date.now() - started;
		assert.ok(took >= DAEMON_HELLO_TIMEOUT_MS - 50 && took < DAEMON_HELLO_TIMEOUT_MS + 2_000, `took ${took} ms`);
	} finally {
		silent.close();
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

// --- Against the real CodeGraph ---

const norm = (text: string | undefined) => (text ?? "").replace(/\r\n/g, "\n").trim();
const timed = async <T>(run: () => Promise<T>) => {
	const started = Date.now();
	const value = await run();
	return { value, ms: Date.now() - started };
};

/** The CLI's explore, kept only as the baseline the daemon's text is compared against. */
const cliExplore = (dir: string, query: string): string =>
	spawnSync(`codegraph explore ${query}`, { cwd: dir, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";

test("S15 real: with the daemon alive, the pipe answers with the same text as the CLI, and faster", { skip: !hasCodegraph }, async () => {
	const dir = indexedProject();
	try {
		stopDaemon(dir);
		assert.equal(await warmUpDaemon(dir), true);
		const cli = await timed(async () => cliExplore(dir, "warmFn1 run"));
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

// --- S4: the daemon of one checkout, resolved from that checkout only, never from MCP configuration ---

test("S4: a checkout's live registered daemon is reported with its socket, and its status is live", async () => {
	const daemon = await fakeDaemon({});
	try {
		const registryDir = registry([{ root: ROOT, socketPath: daemon.path, startedAt: 7 }]);
		assert.deepEqual(liveDaemon(ROOT, registryDir), { root: ROOT, socketPath: daemon.path, pid: process.pid });
		assert.equal(daemonStatus(ROOT, registryDir), "live");
	} finally {
		daemon.close();
	}
});

test("S4: a record whose daemon is gone is dead, an empty registry is none, and neither is a live daemon", async () => {
	const dead = pipePath();
	assert.equal(daemonStatus(ROOT, registry([{ root: ROOT, socketPath: dead }])), "dead");
	assert.equal(daemonStatus(ROOT, registry([])), "none");
	assert.equal(daemonStatus(ROOT, join(tmpdir(), "pcs-no-registry-here")), "none");
	assert.equal(liveDaemon(ROOT, registry([{ root: ROOT, socketPath: dead }])), undefined);
});

test("S4: a worktree is its own checkout: its parent's daemon is never its own", async (t) => {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "pcs-parent-")));
	const child = realpathSync(mkdtempSync(join(tmpdir(), "pcs-child-")));
	const daemon = await fakeDaemon({});
	try {
		const registryDir = registry([{ root: parent, socketPath: daemon.path }]);
		assert.equal(daemonStatus(child, registryDir), "none");
		assert.equal(liveDaemon(child, registryDir), undefined);
		assert.equal(registeredRoot(child, registryDir), undefined, "the parent's spelling is never handed to a child");
		assert.deepEqual(await exploreViaDaemon(child, "q", 2_000, { registryDir }), { status: "unavailable" });
	} finally {
		daemon.close();
		t.after?.(() => undefined);
	}
});

test("S4: an MCP server entry is not evidence of a reachable daemon", (t) => {
	// A checkout whose MCP configuration names the CodeGraph server, and whose daemon registry says nothing.
	const checkout = realpathSync(mkdtempSync(join(tmpdir(), "pcs-mcp-")));
	writeFileSync(join(checkout, "mcp.json"), JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"] } } }));
	assert.equal(daemonStatus(checkout, registry([])), "none");
	assert.equal(liveDaemon(checkout, registry([])), undefined);
	t.after(() => undefined);
});

test("S4: a live daemon needs no MCP entry to be resolved and used", async () => {
	const daemon = await fakeDaemon({});
	try {
		const registryDir = registry([{ root: ROOT, socketPath: daemon.path }]);
		assert.equal(daemonStatus(ROOT, registryDir), "live");
		assert.deepEqual(await exploreViaDaemon(ROOT, "q", 5_000, { registryDir }), { status: "ok", text: "FAKE EXPLORE OUTPUT" });
	} finally {
		daemon.close();
	}
});
