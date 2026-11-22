import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_WITH_MCP_TOOL, CODEGRAPH_MCP_TOOL } from "./agents.ts";

/**
 * Gentle-pi 4.9.0 subagent tool overlay (gentle-shell#3133): a load-time layer that adds/removes subagent
 * tools without editing package-owned agent files. This package publishes one drop-in file under
 * `<configHome>/agent-overlays.d/` instead of rewriting the agent .md files, so managed ownership of the
 * agents stays with gentle-pi and its installer never skips them again.
 *
 * Drop-in sources merge lowest to highest (extension drop-in < global tools.json < project tools.json), but
 * every source is additive per agent; our file only ever adds one tool, so it composes cleanly with anything
 * else the user or other packages write.
 */

/** The one tool this package must place into the subagent allowlist. */
export const TOOL_TO_ADD = CODEGRAPH_MCP_TOOL;

/** Agents the overlay covers; the same set the legacy file path covers. */
export const OVERLAY_AGENTS: readonly string[] = [...AGENTS_WITH_MCP_TOOL];

/** Directory inside configHome where extension drop-ins live, as gentle-pi reads it. */
export const OVERLAY_DROPPIN_DIR = "agent-overlays.d";

/** Our drop-in file name; namespaced so other packages never collide with it. */
export const CODEGRAPH_DROPPIN = "zhalker-codegraph-subagents.json";

export interface ConfigHomeInput {
	home: string;
	env: Pick<NodeJS.ProcessEnv, "GENTLE_PI_CONFIG_HOME" | "GENTLE_SHELL_CONFIG_HOME">;
	/** Bundled gentle-shell prefix; when `<prefix>/config/gentle-ai` exists it wins, like gentle-pi's own resolution. */
	prefix?: string;
}

/**
 * Resolves gentle-pi's config home with the same precedence its own resolution uses (see gentle-pi
 * lib/gentle-shell-bundled.ts): an existing bundled prefix directory first, then GENTLE_PI_CONFIG_HOME,
 * then GENTLE_SHELL_CONFIG_HOME (absolute values only), then `<home>/.pi/gentle-ai`.
 */
export function resolveConfigHome(input: ConfigHomeInput): string {
	const bundled = input.prefix === undefined ? undefined : join(input.prefix, "config", "gentle-ai");
	if (bundled !== undefined && existsSync(bundled)) return bundled;
	// gentle-pi honors GENTLE_PI_CONFIG_HOME verbatim (relative included; only empty counts as unset) and
	// gates just the launcher marker to absolute values. Matching that exactly matters: a config home
	// gentle-pi does not read would leave the tool silently outside every subagent allowlist.
	if (input.env.GENTLE_PI_CONFIG_HOME !== undefined && input.env.GENTLE_PI_CONFIG_HOME.trim().length > 0) {
		return input.env.GENTLE_PI_CONFIG_HOME;
	}
	const marker = input.env.GENTLE_SHELL_CONFIG_HOME;
	if (marker !== undefined && marker.trim().length > 0) {
		const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(marker) || marker.startsWith("\\\\") || marker.startsWith("/");
		if (looksAbsolute) return marker;
	}
	return join(input.home, ".pi", "gentle-ai");
}

/**
 * Reads the installed gentle-pi version from its package.json. The package lives beside ours under
 * `<agentDir>/npm/node_modules/gentle-pi` (direct link or pnpm symlink: reading follows links). Returns
 * undefined when the package is absent or unreadable, so callers fall back to the legacy path.
 */
export function findGentlePiVersion(agentDir: string): string | undefined {
	const file = join(agentDir, "npm", "node_modules", "gentle-pi", "package.json");
	let text: string;
	try { text = readFileSync(file, "utf8"); } catch { return undefined; }
	try {
		const version = (JSON.parse(text) as { version?: unknown }).version;
		return typeof version === "string" && version.trim().length > 0 ? version.trim() : undefined;
	} catch { return undefined; }
}

/**
 * True when the installed gentle-pi implements the subagent tool overlay (gentle-shell#3133, shipped in
 * 4.9.0). Conservative: only final 4.9.0+ releases count; prereleases and unreadable versions use the
 * legacy file-editing path, which stays correct even on a 4.9.0 that also applies an overlay.
 */
export function shouldUseOverlay(version: string | undefined): boolean {
	if (version === undefined) return false;
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
	if (match === null) return false;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	return major > 4 || (major === 4 && minor >= 9);
}

export interface OverlayResult {
	/** Drop-in files written on this call. */
	changed: string[];
	/** One message per failure; failures never throw. */
	errors: string[];
}

function overlayEntry(): { add: string[]; remove: string[] } {
	return { add: [TOOL_TO_ADD], remove: [] };
}

/**
 * Writes our drop-in overlay file into `<configHome>/agent-overlays.d/`, creating directories as needed.
 * Idempotent: an unchanged file is not rewritten (an honest `changed` list, so sessions can report truthfully).
 * Never throws: failures land in `errors`.
 */
export function applyToolOverlays(input: { configHome: string }): OverlayResult {
	const result: OverlayResult = { changed: [], errors: [] };
	const dir = join(input.configHome, OVERLAY_DROPPIN_DIR);
	const file = join(dir, CODEGRAPH_DROPPIN);
	const entries: Record<string, { add: string[]; remove: string[] }> = {};
	for (const agent of OVERLAY_AGENTS) entries[agent] = overlayEntry();
	const text = JSON.stringify(entries, null, 2) + "\n";
	try {
		mkdirSync(dir, { recursive: true });
		let current: string | undefined;
		try { current = readFileSync(file, "utf8"); } catch { /* new file */ }
		if (current !== text) {
			writeFileSync(file, text);
			result.changed.push(file);
		}
	} catch (error) {
		result.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return result;
}
