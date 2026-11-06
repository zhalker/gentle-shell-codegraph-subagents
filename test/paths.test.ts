// One root identity, and codegraph never spawned with the project as its working directory.
// Ported from the office patch (backlog row 1); the UNC cases use whatever mapped drive or admin share this machine has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalRoot, codegraphSpawn, foldRoot, PROJECT_ENV, serveCommand } from "../src/paths.ts";
import { normalizeRoot, projectArgument, registeredRoot } from "../src/daemonclient.ts";
import { runCodegraph } from "../src/autoindex.ts";
import { exploreOnce } from "../src/warmup.ts";
import { adminShareOf, BACKSLASH as B, fakeCodegraph, mappedDrive } from "./helpers.ts";

const UNC = B + B + ["fileserver", "share", "project", "www"].join(B);
const MAPPED = ["Y:", "project", "www"].join(B);
const mapped = mappedDrive();
const DEAD_PID = 2_147_483_000;

const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function registry(records: Record<string, unknown>[]): string {
	const reg = temp("pcs-reg-");
	records.forEach((record, i) => writeFileSync(join(reg, `${i}.json`), JSON.stringify(record)));
	return reg;
}

test("foldRoot: case folding only on Windows; trailing separators go, roots stay roots", () => {
	assert.equal(foldRoot(`C:${B}Users${B}me${B}`, "win32"), `c:${B}users${B}me`);
	assert.equal(foldRoot(`C:${B}`, "win32"), `c:${B}`);
	assert.equal(foldRoot(`${UNC}${B}`, "win32"), UNC.toLowerCase());
	assert.equal(foldRoot("/srv/Repo/", "linux"), "/srv/Repo");
	assert.equal(foldRoot("/", "linux"), "/");
	assert.equal(foldRoot("/Users/Me/Repo", "darwin"), "/Users/Me/Repo");
});

test("canonicalRoot: a local root is one identity in any letter case or with a trailing separator; a missing path falls back to resolve", () => {
	const local = temp("pcs-local-");
	if (process.platform === "win32") assert.equal(canonicalRoot(local.toUpperCase()), canonicalRoot(local));
	assert.equal(canonicalRoot(local + (process.platform === "win32" ? B : "/")), canonicalRoot(local));
	const missing = join(local, "no", "such", "Dir");
	assert.equal(canonicalRoot(missing), foldRoot(resolve(missing)));
	// daemonclient keeps exporting normalizeRoot for its callers; it is the same identity now.
	assert.equal(normalizeRoot(local), canonicalRoot(local));
});

test("canonicalRoot: a local root keeps the identity 0.2.0 gave it, so its init-lock key does not move", () => {
	const local = temp("pcs-lock-");
	const key = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
	let real = realpathSync(local);
	if (process.platform === "win32") real = real.toLowerCase();
	assert.equal(key(canonicalRoot(local)), key(real));
});

test("canonicalRoot: a mapped drive and the UNC path behind it are one root", { skip: mapped === undefined && "no mapped network drive on this machine" }, () => {
	const { drive, unc } = mapped!;
	assert.equal(canonicalRoot(drive), canonicalRoot(unc));
	assert.equal(canonicalRoot(drive.toLowerCase()), canonicalRoot(unc));
	assert.equal(canonicalRoot(unc + B), canonicalRoot(unc));
});

test("registeredRoot: the spelling the newest daemon registered, in any spelling of the root; undefined when none matches", () => {
	const local = temp("pcs-proj-");
	const reg = registry([{ root: local.toUpperCase(), socketPath: "x", startedAt: 1 }, { root: local, socketPath: "y", startedAt: 2 }]);
	writeFileSync(join(reg, "damaged.json"), "{ damaged");
	assert.equal(registeredRoot(process.platform === "win32" ? local.toUpperCase() + B : local + "/", reg), local);
	assert.equal(registeredRoot(temp("pcs-other-"), reg), undefined);
	assert.equal(registeredRoot(local, join(reg, "missing")), undefined);
});

test("registeredRoot: a live daemon wins over a newer dead record, whose spelling would start a duplicate", () => {
	const local = temp("pcs-alive-");
	const other = process.platform === "win32" ? local.toUpperCase() : local;
	assert.equal(registeredRoot(local, registry([
		{ root: local, socketPath: "a", startedAt: 1, pid: process.pid },
		{ root: other, socketPath: "b", startedAt: 2, pid: DEAD_PID },
	])), local);
	// With nothing alive, the newest record still names the project.
	assert.equal(registeredRoot(local, registry([
		{ root: local, socketPath: "a", startedAt: 1, pid: DEAD_PID },
		{ root: other, socketPath: "b", startedAt: 2, pid: DEAD_PID + 1 },
	])), other);
});

test("registeredRoot: a missing or non-numeric pid is never taken as alive", { skip: process.platform !== "win32" && "needs a case-insensitive spelling" }, () => {
	const proj = temp("pcs-pid-");
	for (const bad of [undefined, "99999", true, null]) {
		const reg = registry([
			{ root: proj, socketPath: "a", startedAt: 9, pid: bad },
			{ root: proj.toUpperCase(), socketPath: "b", startedAt: 1, pid: process.pid },
		]);
		assert.equal(registeredRoot(proj, reg), proj.toUpperCase(), `pid=${String(bad)} must not win as alive`);
		assert.equal(registeredRoot(proj, registry([{ root: proj, socketPath: "a", startedAt: 9, pid: bad }])), proj);
	}
});

test("registeredRoot: of two live records the newest wins; a single record is returned as it is", { skip: process.platform !== "win32" && "needs a case-insensitive spelling" }, () => {
	const proj = temp("pcs-two-");
	assert.equal(registeredRoot(proj, registry([
		{ root: proj, socketPath: "a", startedAt: 1, pid: process.pid },
		{ root: proj.toUpperCase(), socketPath: "b", startedAt: 9, pid: process.ppid },
	])), proj.toUpperCase());
	assert.equal(registeredRoot(proj, registry([{ root: proj.toUpperCase(), socketPath: "a", startedAt: 5, pid: DEAD_PID }])), proj.toUpperCase());
});

test("registeredRoot: a daemon registered for a child or a sibling folder is never selected for the parent", () => {
	const parent = temp("pcs-parent-");
	const reg = registry([
		{ root: join(parent, "v3"), socketPath: "pipe", startedAt: 1 },
		{ root: join(parent, "v30"), socketPath: "pipe", startedAt: 2 },
	]);
	assert.equal(registeredRoot(parent, reg), undefined);
	assert.equal(registeredRoot(join(parent, "v3"), reg), join(parent, "v3"));
});

test("registeredRoot: a child's UNC path finds the daemon registered with the mapped drive", { skip: mapped === undefined && "no mapped network drive on this machine" }, () => {
	const { drive, unc } = mapped!;
	assert.equal(registeredRoot(unc, registry([{ root: drive, socketPath: "x", startedAt: 1 }])), drive);
});

test("projectArgument: the registered spelling when there is one, otherwise the path as given", { skip: process.platform !== "win32" && "needs a case-insensitive spelling" }, () => {
	const local = temp("pcs-dup-");
	const reg = registry([{ root: local.toUpperCase(), socketPath: "a", startedAt: 1 }, { root: local, socketPath: "b", startedAt: 2 }]);
	assert.equal(projectArgument(local.toUpperCase(), reg), local);
	assert.equal(projectArgument(local, reg), local);
	const unregistered = temp("pcs-none-");
	assert.equal(projectArgument(unregistered, reg), unregistered);
});

test("codegraphSpawn: from the temp dir with the project appended; Windows through cmd.exe with the path in PROJECT_ENV, POSIX without a shell", () => {
	const win = codegraphSpawn(["sync", "-q"], UNC, "win32");
	assert.deepEqual(win, { command: `codegraph sync -q "%${PROJECT_ENV}%"`, args: [], cwd: tmpdir(), shell: true, env: { [PROJECT_ENV]: UNC } });
	// A trailing backslash would escape the closing quote, so a drive root is passed as C:\. (the same directory).
	assert.deepEqual(codegraphSpawn(["sync", "-q"], `C:${B}`, "win32").env, { [PROJECT_ENV]: `C:${B}.` });
	const posix = codegraphSpawn(["init", "-y"], "/srv/my repo", "linux");
	assert.deepEqual(posix, { command: "codegraph", args: ["init", "-y", "/srv/my repo"], cwd: tmpdir(), shell: false, env: {} });
});

test("serveCommand: the warm-up names the project with -p, taken by the platform shell from PROJECT_ENV", () => {
	assert.deepEqual(serveCommand("codegraph serve --mcp", MAPPED, "win32"), { command: `codegraph serve --mcp -p "%${PROJECT_ENV}%"`, env: { [PROJECT_ENV]: MAPPED } });
	assert.deepEqual(serveCommand("codegraph serve --mcp", "/srv/my repo", "linux"), { command: `codegraph serve --mcp -p "$${PROJECT_ENV}"`, env: { [PROJECT_ENV]: "/srv/my repo" } });
});

async function recordedRun(args: string[], project: string): Promise<string> {
	const out = join(temp("pcs-out-"), "args.txt");
	const fake = fakeCodegraph(out);
	try {
		assert.equal(await runCodegraph(args, project, 20_000), true);
	} finally {
		fake.restore();
	}
	return readFileSync(out, "utf8");
}

test("runCodegraph runs codegraph from the temp dir with the project as the last argument", async () => {
	const project = temp("pcs-run-");
	assert.equal(await recordedRun(["sync", "-q"], project), `${tmpdir()}|sync -q ${project}`);
	assert.equal(await recordedRun(["init", "-y"], project), `${tmpdir()}|init -y ${project}`);
});

// cmd.exe expands %VAR% even inside quotes; & and ^ split or escape outside them. None of these is invalid in a folder name.
const AWKWARD = ["a%OS%b", "a&b", "a^b", "a b", "it's", "x%"];

test("runCodegraph hands codegraph the project path literally, whatever shell characters its folder name has", async () => {
	const base = temp("pcs-awk-");
	for (const name of AWKWARD) {
		const project = join(base, name);
		mkdirSync(project);
		assert.equal(await recordedRun(["sync", "-q"], project), `${tmpdir()}|sync -q ${project}`, name);
	}
});

test("runCodegraph works for a project given as a UNC path, which cmd.exe rejects as a working directory", { skip: adminShareOf(tmpdir()) === undefined && "no reachable administrative share" }, async () => {
	const unc = adminShareOf(temp("pcs-unc-"))!;
	assert.equal(await recordedRun(["sync", "-q"], unc), `${tmpdir()}|sync -q ${unc}`);
});

async function recordedWarmUp(project: string): Promise<string> {
	const dir = temp("pcs-warm-");
	const recorder = join(dir, "record.mjs");
	const out = join(dir, "warmup-args.txt");
	writeFileSync(recorder, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, process.cwd() + "|" + process.argv.slice(2).join(" "));\n`);
	const result = await exploreOnce(project, "main", 10_000, `"${process.execPath}" "${recorder}"`);
	assert.equal(result.ok, false, "the recorder is not an MCP server");
	assert.ok(existsSync(out), "the warm-up started its command");
	return readFileSync(out, "utf8");
}

test("the warm-up runs from the temp dir and names the project with -p, never as its working directory", async () => {
	const project = temp("pcs-warmproj-");
	assert.equal(await recordedWarmUp(project), `${tmpdir()}|-p ${project}`);
});

test("the warm-up hands the server the project path literally, whatever shell characters its folder name has", async () => {
	const base = temp("pcs-warmawk-");
	for (const name of AWKWARD) {
		const project = join(base, name);
		mkdirSync(project);
		assert.equal(await recordedWarmUp(project), `${tmpdir()}|-p ${project}`, name);
	}
});

test("the warm-up works for a project given as a UNC path", { skip: adminShareOf(tmpdir()) === undefined && "no reachable administrative share" }, async () => {
	const unc = adminShareOf(temp("pcs-warmunc-"))!;
	assert.equal(await recordedWarmUp(unc), `${tmpdir()}|-p ${unc}`);
});
