import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAgent } from "./agents.ts";
import { inspectEffectiveMcpExposure, isCodegraphServerMissing, normalizeMcpConfig } from "./mcp.ts";

export interface ApplyResult {
	/** Files that were rewritten. */
	changed: string[];
	/** One message per file that could not be processed. */
	errors: string[];
}

const BACKUP_SUFFIX = ".pre-codegraph-subagents.bak";

/** Reads the effective file settings only; untrusted project configuration is not loaded by Pi. */
export function readExposureWarning(agentDir: string, cwd: string, projectTrusted: boolean): string | undefined {
	const read = (path: string): string | undefined => {
		try { return readFileSync(path, "utf8"); } catch { return undefined; }
	};
	const global = read(join(agentDir, "mcp.json")) ?? "{}";
	const project = projectTrusted ? read(join(cwd, ".pi", "mcp.json")) : undefined;
	return inspectEffectiveMcpExposure(global, project);
}

/** Reports absent file configuration without creating it; registered servers also count. */
export function readMissingServerWarning(agentDir: string, cwd: string, projectTrusted: boolean, registered = false): boolean {
	const read = (path: string): string | undefined => {
		try { return readFileSync(path, "utf8"); } catch (error) {
			return codeOf(error) === "ENOENT" ? undefined : "invalid";
		}
	};
	const global = read(join(agentDir, "mcp.json")) ?? "{}";
	const project = projectTrusted ? read(join(cwd, ".pi", "mcp.json")) : undefined;
	return isCodegraphServerMissing(global, project, registered);
}

// Write beside the target and rename, so a reader never sees a half-written file.
function writeAtomic(file: string, text: string): void {
	const temp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, text);
		renameSync(temp, file);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* nothing to clean */ }
		throw error;
	}
}

// Several sessions can start at the same moment and rewrite the same files: on Windows a rename over a file
// another session is replacing fails with one of these, and a retry finds the work already done.
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"]);
const ATTEMPTS = 8;

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

function pauseBriefly(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 30));
}

// The backup holds the original, so whoever gets there first wins and the others leave it alone.
function saveBackupOnce(file: string, original: string): void {
	try {
		writeFileSync(file + BACKUP_SUFFIX, original, { flag: "wx" });
	} catch (error) {
		if (codeOf(error) !== "EEXIST") throw error;
	}
}

function alreadyNormalized(file: string, normalize: (text: string) => string): boolean {
	try {
		const text = readFileSync(file, "utf8");
		return normalize(text) === text;
	} catch {
		return false;
	}
}

function rewrite(file: string, normalize: (text: string) => string, result: ApplyResult): void {
	let failure: unknown;
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		try {
			const before = readFileSync(file, "utf8");
			const after = normalize(before);
			// Already right: nothing to do, or another session just did it.
			if (after === before) return;
			saveBackupOnce(file, before);
			writeAtomic(file, after);
			result.changed.push(file);
			return;
		} catch (error) {
			failure = error;
			if (!TRANSIENT_CODES.has(codeOf(error) ?? "")) break;
			pauseBriefly();
		}
	}
	if (alreadyNormalized(file, normalize)) return;
	result.errors.push(`${file}: ${failure instanceof Error ? failure.message : String(failure)}`);
}

/**
 * Applies the CodeGraph wiring to the global agent definitions and to mcp.json
 * under `agentDir`. Idempotent and never throws: failures are returned in `errors`.
 */
export function applyCodegraphSubagents(agentDir: string): ApplyResult {
	const result: ApplyResult = { changed: [], errors: [] };
	for (const folder of ["agents", "subagents"]) {
		const dir = join(agentDir, folder);
		let entries: string[];
		try {
			entries = readdirSync(dir).filter((entry) => entry.toLowerCase().endsWith(".md")).sort();
		} catch {
			continue;
		}
		for (const entry of entries) rewrite(join(dir, entry), normalizeAgent, result);
	}
	const mcp = join(agentDir, "mcp.json");
	if (existsSync(mcp)) rewrite(mcp, normalizeMcpConfig, result);
	return result;
}
