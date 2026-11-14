import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectEffectiveMcpExposure, isCodegraphServerMissing } from "./mcp.ts";

// This package writes no agent file and no mcp.json: gentle-shell ships the CodeGraph MCP tool in its own
// agent assets, and exposure is only read here to decide whether that shipped tool is reachable.

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

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;
