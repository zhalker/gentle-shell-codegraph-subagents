// `node --test` exits 0 when its glob matches nothing or the files hold no test, so a broken test layout
// would pass `npm test` and `prepublishOnly`. This runs the same tests and fails unless at least one test
// ran and none failed. Usage: node scripts/run-tests.mjs [glob...] (default: test/*.test.ts).
import { resolve } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const globPatterns = process.argv.length > 2 ? process.argv.slice(2) : ["test/*.test.ts"];
let summary;
let realTests = 0;

// A file that defines no test is reported as one test named after the file itself; that is not a test.
const countTest = (event) => {
	if (event.details?.type === "suite") return;
	if (event.file !== undefined && resolve(event.name) === resolve(event.file)) return;
	realTests++;
};

// Test files in parallel processes, as `node --test` runs them.
const stream = run({ globPatterns, concurrency: true });
stream.on("test:pass", countTest);
stream.on("test:fail", countTest);
stream.on("test:summary", (event) => {
	// The last summary, with no file, covers the whole run; per-file summaries come before it.
	if (event.file === undefined) summary = event;
});
stream.on("end", () => {
	if (summary === undefined || !summary.success) {
		process.exitCode = 1;
	} else if (realTests === 0) {
		process.stderr.write(`no tests ran for ${globPatterns.join(" ")}\n`);
		process.exitCode = 1;
	}
});
stream.compose(spec).pipe(process.stdout);
