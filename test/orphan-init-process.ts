// A stand-in for `codegraph init`, started the way the package starts it on Windows: through a shell, so the
// pid the session adopts is the shell and not this process. Like the real init, this process announces itself
// in CodeGraph's own lock and removes that file when it ends; it is not the child of the shell's death.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , project, holdMs] = process.argv;
const directory = join(project, ".codegraph");
mkdirSync(directory, { recursive: true });
const lock = join(directory, "codegraph.lock");
writeFileSync(lock, String(process.pid));
setTimeout(() => {
	try { rmSync(lock, { force: true }); } catch { /* the file is already gone */ }
	process.exit(0);
}, Number(holdMs) || 30_000);
