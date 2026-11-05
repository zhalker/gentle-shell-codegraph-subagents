import { exploreOnce } from "../src/warmup.ts";

/** Runs one warm-up against the MCP server named in argv[2] and must then exit on its own; it never exits on purpose. */
const command = process.argv[2] ?? "";
const result = await exploreOnce(process.cwd(), "main", 300, command);
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
