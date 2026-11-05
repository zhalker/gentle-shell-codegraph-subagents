// Entry point for the concurrency test: one "session" that applies the package to a directory at a given instant.
import { applyCodegraphSubagents } from "../src/apply.ts";

const [, , dir, startAt] = process.argv;
while (Date.now() < Number(startAt)) { /* spin until every session starts at the same instant */ }
console.log(JSON.stringify(applyCodegraphSubagents(dir)));
