import { createInterface } from "node:readline";

/** A tiny stdio MCP server standing in for `codegraph serve --mcp`; the mode is argv[2]. */
const mode = process.argv[2] ?? "ok";

function send(message: object): void {
	process.stdout.write(JSON.stringify(message) + "\n");
}

/** CodeGraph answers a crashed worker with `isError: true` and a text, not with a JSON-RPC error. */
function exploreResult(): object {
	if (mode === "isError") return { isError: true, content: [{ type: "text", text: "codegraph worker crashed; please retry the call." }] };
	if (mode === "empty") return {};
	return { content: [{ type: "text", text: "FAKE EXPLORE OUTPUT" }] };
}

// A stuck server answers the first call, ignores its stdin closing and leaves on its own twenty seconds later.
// Every other mode goes away as soon as its stdin ends, like the real server does.
if (mode === "stuck") setTimeout(() => process.exit(0), 20_000);
else process.stdin.on("end", () => process.exit(0));

createInterface({ input: process.stdin }).on("line", (line) => {
	const trimmed = line.trim();
	if (trimmed.length === 0) return;
	let message: { id?: number; method?: string };
	try { message = JSON.parse(trimmed); } catch { return; }
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
	} else if (message.method === "tools/call" && mode !== "stuck") {
		send({ jsonrpc: "2.0", id: message.id, result: exploreResult() });
	}
});
