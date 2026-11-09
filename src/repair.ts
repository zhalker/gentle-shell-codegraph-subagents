import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeAgentV010, normalizeAgentV020ToV060 } from "./legacy-agents.ts";
import { WORKER_MARKER } from "./skill-reminder.ts";

/**
 * Where a repaired file waits for gentle-pi to recreate it: a swap, never a delete (S11). Not `.md`, so
 * neither this package's session-start pass nor Pi reads it as an agent, and not the `.bak`.
 */
export const PENDING_SUFFIX = ".codegraph-repair-pending";
const BACKUP_SUFFIX = ".pre-codegraph-subagents.bak";
const AGENTS = "agents";
const STATE_FOLDER = "codegraph-subagents";
const STATE_FILE = "repair-state.json";
const GENTLE_PI_TREE = join("npm", "node_modules", "gentle-pi");
const BODY_HISTORY = join("assets", "migrations", "agent-body-history.json");
const MANIFEST = join("gentle-ai", "managed-assets.json");

// gentle-ai appends its blocks; this matches the whole block and the blank lines around it.
const GENTLE_AI_BLOCK = /\s*<!-- gentle-ai:pi-codegraph-(?:tool|guidance) -->[\s\S]*?<!-- \/gentle-ai:pi-codegraph -->\s*/g;
const GENTLE_AI_MARK = "gentle-ai:pi-codegraph";
const TRAILING_WORKER_MARKER = new RegExp(`(?:\\r?\\n)*${escapeRegExp(WORKER_MARKER)}(?:\\r?\\n)?\\s*$`);
const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/;
const ROUTING = /^(model|thinking):\s*(.*)$/;

type Env = Record<string, string | undefined>;

export interface RepairNote {
	/** Full path of the agent file the note is about. */
	file: string;
	reason: string;
}

export interface RepairOutcome {
	/** Files moved aside so gentle-pi recreates them from its own assets. */
	repaired: RepairNote[];
	/** Repaired copies that were settled: removed (gentle-pi recreated the file) or rolled back. */
	settled: RepairNote[];
	/** Files that were looked at and left alone, each with its reason. */
	skipped: RepairNote[];
}

export interface RepairInput {
	agentDir: string;
	home: string;
	env: Env;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function parseJson(text: string | undefined): unknown {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const emptyOutcome = (): RepairOutcome => ({ repaired: [], settled: [], skipped: [] });

/** gentle-pi's body of an agent file: everything from the frontmatter's closing line on. */
function agentBody(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const end = content.indexOf("\n---", 4);
	return end === -1 ? content : content.slice(end);
}

/**
 * gentle-ai appends `body without its trailing newlines + "\n\n" + block` to a shipped body, so undoing
 * the append leaves the body without its final newline; the body as shipped counts as well.
 */
function withoutGentleAiBlocks(body: string): string[] {
	if (!body.includes(GENTLE_AI_MARK)) return [body];
	const stripped = body.replace(GENTLE_AI_BLOCK, "");
	return stripped === body ? [body] : [stripped, `${stripped}\n`];
}

/** A worker re-marked by 0.6.0 carries one more line than the shipped body. */
function withoutWorkerMarker(body: string): string[] {
	const stripped = body.replace(TRAILING_WORKER_MARKER, "");
	return stripped === body ? [body] : [stripped, `${stripped}\n`];
}

interface Frontmatter {
	open: string;
	front: string;
	close: string;
	body: string;
	eol: string;
}

function frontmatterOf(text: string): Frontmatter | undefined {
	const match = FRONTMATTER.exec(text);
	if (match === null) return undefined;
	return { open: match[1], front: match[2], close: match[3], body: match[4], eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

const unquote = (value: string): string => {
	const v = value.trim();
	return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
};

/** The `model:` and `thinking:` lines of the frontmatter. */
function routingOf(text: string): Record<string, string> {
	const parts = frontmatterOf(text);
	const routing: Record<string, string> = {};
	if (parts === undefined) return routing;
	for (const line of parts.front.split(/\r?\n/)) {
		const match = ROUTING.exec(line);
		if (match !== null) routing[match[1]] = unquote(match[2]);
	}
	return routing;
}

/** The file without the routing lines, exactly as gentle-pi leaves them out when it writes its own assets. */
function withoutRouting(text: string): string {
	const parts = frontmatterOf(text);
	if (parts === undefined) return text;
	const lines = parts.front.split(/\r?\n/);
	const kept = lines.filter((line) => !/^(?:model|thinking):/.test(line));
	if (kept.length === lines.length) return text;
	return parts.open + kept.join(parts.eol) + parts.close + parts.body;
}

/** gentle-pi's config home: an explicit GENTLE_PI_CONFIG_HOME, the launcher's marker, then ~/.pi/gentle-ai. */
function configHome(env: Env, home: string): string {
	if (env.GENTLE_PI_CONFIG_HOME) return env.GENTLE_PI_CONFIG_HOME;
	const marker = env.GENTLE_SHELL_CONFIG_HOME;
	if (marker !== undefined && marker.length > 0 && isAbsolute(marker)) return marker;
	return join(home, ".pi", "gentle-ai");
}

/** The routing gentle-pi saved per agent; a missing or unreadable file counts as no entries. */
function readModels(env: Env, home: string): Record<string, Record<string, string>> {
	const parsed = parseJson(readText(join(configHome(env, home), "models.json")));
	const models: Record<string, Record<string, string>> = {};
	if (!isRecord(parsed)) return models;
	for (const [agent, entry] of Object.entries(parsed)) {
		if (!isRecord(entry)) continue;
		const routing: Record<string, string> = {};
		for (const key of ["model", "thinking"]) {
			const value = entry[key];
			if (typeof value === "string") routing[key] = value;
		}
		models[agent] = routing;
	}
	return models;
}

interface GentlePi {
	/** The body history of gentle-pi's shipped agents: `agents/<name>.md` to the hashes of its bodies. */
	bodies: Record<string, string[]>;
	/** Its `managed-assets.json`: `agents/<name>.md` to the hash of the content it wrote. */
	manifest: Record<string, string>;
	dir: string;
}

type Discovery = { found: true; pi: GentlePi } | { found: false; reason: string };

/** Locates gentle-pi where Pi installs it and reads what the repair needs from it. */
function openGentlePi(agentDir: string): Discovery {
	const dir = join(agentDir, GENTLE_PI_TREE);
	const pkg = parseJson(readText(join(dir, "package.json")));
	if (!isRecord(pkg) || pkg.name !== "gentle-pi") return { found: false, reason: `gentle-pi was not found in ${dir}` };
	const history = parseJson(readText(join(dir, BODY_HISTORY)));
	if (!isRecord(history) || history.schemaVersion !== 1 || !isRecord(history.bodies)) {
		return { found: false, reason: `${join(dir, BODY_HISTORY)} is missing or unreadable` };
	}
	const bodies: Record<string, string[]> = {};
	for (const [key, hashes] of Object.entries(history.bodies)) {
		if (Array.isArray(hashes) && hashes.every((hash) => typeof hash === "string")) bodies[key] = hashes as string[];
	}
	const manifest = parseJson(readText(join(agentDir, MANIFEST)));
	const assets: Record<string, string> = {};
	if (isRecord(manifest) && isRecord(manifest.assets)) {
		for (const [key, hash] of Object.entries(manifest.assets)) if (typeof hash === "string") assets[key] = hash;
	}
	return { found: true, pi: { bodies, manifest: assets, dir } };
}

interface NoRetryRecord {
	content: string;
	backup: string;
}

interface RepairState {
	noRetry: Record<string, NoRetryRecord>;
}

function statePath(agentDir: string): string {
	return join(agentDir, STATE_FOLDER, STATE_FILE);
}

// Only the files a rollback proved unrestorable are remembered, and only while they are unchanged.
function readState(agentDir: string): RepairState {
	const parsed = parseJson(readText(statePath(agentDir)));
	const state: RepairState = { noRetry: {} };
	if (!isRecord(parsed) || !isRecord(parsed.noRetry)) return state;
	for (const [name, entry] of Object.entries(parsed.noRetry)) {
		if (isRecord(entry) && typeof entry.content === "string" && typeof entry.backup === "string") {
			state.noRetry[name] = { content: entry.content, backup: entry.backup };
		}
	}
	return state;
}

function writeState(agentDir: string, state: RepairState): void {
	const path = statePath(agentDir);
	const temp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(join(agentDir, STATE_FOLDER), { recursive: true });
		writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, noRetry: state.noRetry }, null, 2)}\n`);
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* nothing to clean */ }
		throw error;
	}
}

/**
 * Creates `to` only when it does not exist and moves `from` there: a plain rename would replace a file
 * another session just wrote, and two sessions can settle or repair the same agent at the same moment.
 * "exists" and "missing" both mean another session got there first.
 */
function moveUnlessExists(from: string, to: string): "moved" | "exists" | "missing" {
	try {
		linkSync(from, to);
	} catch (error) {
		if (codeOf(error) === "EEXIST") return "exists";
		if (codeOf(error) === "ENOENT" && !existsSync(from)) return "missing";
		// A filesystem without hard links: check first and accept the small window.
		if (existsSync(to)) return "exists";
		renameSync(from, to);
		return "moved";
	}
	unlinkSync(from);
	return "moved";
}

/**
 * Whether `original` is a file of its own rather than the other name of `pending`: a swap or restore in
 * another session links one name to the other before unlinking the first, so for a moment both exist and
 * hold the same file. Without inode numbers, equal bytes count as the same file. Unknown means not distinct.
 */
function distinctFiles(original: string, pending: string): boolean {
	try {
		const a = statSync(original, { bigint: true });
		const b = statSync(pending, { bigint: true });
		if (a.ino !== 0n && b.ino !== 0n) return a.ino !== b.ino || a.dev !== b.dev;
		return readFileSync(original, "utf8") !== readFileSync(pending, "utf8");
	} catch {
		return false;
	}
}

function entriesOf(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/**
 * Settles swaps left by an earlier load: a pending copy whose file gentle-pi recreated is removed, and a
 * pending copy whose file is still gone is restored, so an agent file is never left missing.
 */
export function settleAgentFileRepairs(input: { agentDir: string; env: Env }): RepairOutcome {
	return settleAgentFileSwaps(input, true);
}

/**
 * gentle-pi's own agent home (`GENTLE_PI_AGENT_HOME || PI_CODING_AGENT_DIR || ~/.pi/agent`): when it names
 * another directory than the one this extension repairs, gentle-pi installs and recreates its agents there,
 * so a swap here would leave the agent missing for good.
 */
function agentHomeProblem(input: { agentDir: string; env: Env }): string | undefined {
	if (!input.env.GENTLE_PI_AGENT_HOME) return undefined;
	const theirs = input.env.GENTLE_PI_AGENT_HOME;
	const left = resolve(theirs);
	const right = resolve(input.agentDir);
	const same = process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
	if (same) return undefined;
	return `gentle-pi keeps its agent files in ${left} (GENTLE_PI_AGENT_HOME), not in ${right}, so they were left alone`;
}

/**
 * `restore` is false at load: gentle-pi's own startup install has not run in this process yet, so a missing
 * file proves nothing, and a pending copy is left for the load to settle after that install had its chance.
 */
function settleAgentFileSwaps(input: { agentDir: string; env: Env }, restore: boolean): RepairOutcome {
	const outcome = emptyOutcome();
	if (input.env.GENTLE_PI_AGENTS_CHILD === "1") {
		outcome.skipped.push({ file: join(input.agentDir, AGENTS), reason: "a subagent child never settles an agent file" });
		return outcome;
	}
	const home = agentHomeProblem({ agentDir: input.agentDir, env: input.env });
	if (home !== undefined) {
		outcome.skipped.push({ file: input.agentDir, reason: home });
		return outcome;
	}
	const dir = join(input.agentDir, AGENTS);
	const pendingNames = entriesOf(dir).filter((entry) => entry.endsWith(PENDING_SUFFIX));
	let state: RepairState | undefined;
	const changes: RepairNote[] = [];
	for (const name of pendingNames) {
		const pending = join(dir, name);
		const original = join(dir, name.slice(0, -PENDING_SUFFIX.length));
		if (existsSync(original)) {
			if (!distinctFiles(original, pending)) {
				outcome.skipped.push({ file: original, reason: "another session is moving it right now, so it was left alone" });
				continue;
			}
			try {
				unlinkSync(pending);
				outcome.settled.push({ file: original, reason: "gentle-pi recreated the file, so the repaired copy was removed" });
			} catch (error) {
				if (codeOf(error) !== "ENOENT") outcome.skipped.push({ file: original, reason: `its repaired copy could not be removed: ${messageOf(error)}` });
			}
			continue;
		}
		if (!restore) {
			outcome.skipped.push({ file: original, reason: "its repaired copy is waiting for gentle-pi to recreate it, so it was left alone in this load" });
			continue;
		}
		const content = readText(pending);
		let moved: "moved" | "exists" | "missing";
		try {
			moved = moveUnlessExists(pending, original);
		} catch (error) {
			outcome.skipped.push({ file: original, reason: `it could not be restored: ${messageOf(error)}` });
			continue;
		}
		if (moved !== "moved") {
			// The source vanished or another session recreated the file first: its copy is the current one.
			if (moved === "exists") outcome.skipped.push({ file: original, reason: "another session restored it first" });
			continue;
		}
		state ??= readState(input.agentDir);
		const backup = readText(original + BACKUP_SUFFIX);
		state.noRetry[name.slice(0, -PENDING_SUFFIX.length)] = {
			content: sha256(content ?? ""),
			backup: backup === undefined ? "" : sha256(backup),
		};
		changes.push({ file: original, reason: "gentle-pi did not recreate the file, so it was restored and will not be retried while unchanged" });
	}
	if (state !== undefined) {
		try {
			writeState(input.agentDir, state);
		} catch (error) {
			outcome.skipped.push({ file: statePath(input.agentDir), reason: `the record of what was rolled back could not be written: ${messageOf(error)}` });
		}
	}
	outcome.settled.push(...changes);
	return outcome;
}

/** The head of an agent file: everything before gentle-pi's body. */
function headOf(content: string): string {
	return content.slice(0, content.length - agentBody(content).length);
}

/**
 * A shipped body says nothing about the frontmatter above it, where the tools live: the frontmatter must be
 * what a published version of this extension wrote from the agent the installed gentle-pi ships, so a
 * frontmatter edited by hand is never handed back.
 */
function publishedFrontmatter(written: string, pi: GentlePi, name: string): boolean {
	let asset: string;
	try {
		asset = withoutRouting(readFileSync(join(pi.dir, "assets", AGENTS, name), "utf8"));
	} catch {
		return false;
	}
	const head = headOf(written);
	return [normalizeAgentV020ToV060(asset), normalizeAgentV010(asset)].some((made) => headOf(made) === head);
}

/** Why a file is not repaired, or `undefined` when it is. */
function blocker(
	input: { content: string; backup: string | undefined; name: string; agent: string },
	pi: GentlePi,
	models: Record<string, Record<string, string>>,
): string | undefined {
	const key = `${AGENTS}/${input.name}`;
	const shipped = pi.bodies[key] ?? [];
	const isShipped = (body: string): boolean => shipped.includes(sha256(body));
	if (input.backup === undefined) return `it has no ${BACKUP_SUFFIX} to repair it from`;
	if (!withoutGentleAiBlocks(agentBody(input.backup)).some(isShipped)) {
		return "its backup is not a body gentle-pi ships";
	}

	const written = withoutRouting(input.content);
	const published = [normalizeAgentV020ToV060(withoutRouting(input.backup)), normalizeAgentV010(withoutRouting(input.backup))];
	if (!published.includes(written) && !(withoutWorkerMarker(agentBody(input.content)).some(isShipped) && publishedFrontmatter(written, pi, input.name))) {
		return "neither a published version of this extension nor gentle-pi itself wrote its content";
	}

	const saved = models[input.agent];
	for (const [field, value] of Object.entries(routingOf(input.content))) {
		if (saved?.[field] !== value) return `its ${field} is not the one saved in models.json`;
	}
	return undefined;
}

/**
 * Hands frozen agent files back to gentle-pi: a file that a published version of this extension froze, with
 * a backup holding the same bytes, is moved to a pending name so gentle-pi recreates it from its assets in
 * the startup after this load. It never deletes a file, never writes a second backup and never touches a
 * file gentle-pi still manages. Every file it looked at is reported with its reason.
 */
export function repairFrozenAgentFiles(input: RepairInput): RepairOutcome {
	const outcome = emptyOutcome();
	if (input.env.GENTLE_PI_AGENTS_CHILD === "1") {
		outcome.skipped.push({ file: join(input.agentDir, AGENTS), reason: "a subagent child never repairs an agent file" });
		return outcome;
	}
	const home = agentHomeProblem(input);
	if (home !== undefined) {
		outcome.skipped.push({ file: input.agentDir, reason: home });
		return outcome;
	}

	// Settle before anything else: a pending copy next to its recreated file is stale. A pending copy whose
	// file is missing is left for the first prompt of the parent session, after this startup's own install.
	const settled = settleAgentFileSwaps(input, false);
	outcome.settled.push(...settled.settled);
	outcome.skipped.push(...settled.skipped);

	const discovery = openGentlePi(input.agentDir);
	if (!discovery.found) {
		outcome.skipped.push({ file: input.agentDir, reason: discovery.reason });
		return outcome;
	}
	const pi = discovery.pi;
	const dir = join(input.agentDir, AGENTS);
	const models = readModels(input.env, input.home);
	const state = readState(input.agentDir);

	for (const name of entriesOf(dir)) {
		if (!name.toLowerCase().endsWith(".md")) continue;
		const file = join(dir, name);
		const content = readText(file);
		// It vanished between the listing and the read: another session moved it.
		if (content === undefined) continue;
		// gentle-pi rewrites every file it still manages, so such a file was never frozen: leave it alone.
		if (pi.manifest[`${AGENTS}/${name}`] === sha256(content)) continue;
		const agent = name.slice(0, -".md".length);
		const backup = readText(file + BACKUP_SUFFIX);
		const remembered = state.noRetry[name];
		if (remembered !== undefined && backup !== undefined && remembered.content === sha256(content) && remembered.backup === sha256(backup)) {
			outcome.skipped.push({ file, reason: "a rollback already tried it and nothing changed since" });
			continue;
		}
		const reason = blocker({ content, backup, name, agent }, pi, models);
		if (reason !== undefined) {
			outcome.skipped.push({ file, reason });
			continue;
		}
		const pending = file + PENDING_SUFFIX;
		let moved: "moved" | "exists" | "missing" | undefined;
		try {
			moved = moveUnlessExists(file, pending);
		} catch (error) {
			outcome.skipped.push({ file, reason: `it could not be moved aside: ${messageOf(error)}` });
		}
		if (moved === undefined) continue;
		if (moved === "exists") {
			outcome.skipped.push({ file, reason: "another session already holds its repaired copy" });
			continue;
		}
		if (moved === "missing") {
			outcome.skipped.push({ file, reason: "another session repaired it first" });
			continue;
		}
		outcome.repaired.push({ file, reason: "moved aside so gentle-pi recreates it and manages it again" });
	}
	return outcome;
}

export interface RepairNotice {
	text: string;
	level: "info" | "warning";
}

const fileName = (file: string): string => file.split(/[\\/]/).at(-1) ?? file;

function few(notes: RepairNote[]): string {
	const names = notes.map((note) => fileName(note.file));
	return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

function grouped(notes: RepairNote[]): string {
	const reasons = new Map<string, RepairNote[]>();
	for (const note of notes) {
		const known = reasons.get(note.reason) ?? [];
		known.push(note);
		reasons.set(note.reason, known);
	}
	return [...reasons].map(([reason, list]) => `${list.map((note) => fileName(note.file)).join(", ")}: ${reason}`).join("; ");
}

/** One notice per kind of outcome, in the shape the session-start apply report uses. */
export function repairNotices(outcome: RepairOutcome | undefined): RepairNotice[] {
	if (outcome === undefined) return [];
	const notices: RepairNotice[] = [];
	if (outcome.repaired.length > 0) {
		notices.push({ text: `handing ${outcome.repaired.length} frozen agent file(s) back to gentle-pi: ${few(outcome.repaired)}`, level: "info" });
	}
	if (outcome.settled.length > 0) {
		notices.push({ text: `settled ${outcome.settled.length} repaired agent file(s): ${few(outcome.settled)}`, level: "info" });
	}
	if (outcome.skipped.length > 0) {
		notices.push({ text: `left ${outcome.skipped.length} agent file(s) alone (${grouped(outcome.skipped)})`, level: "warning" });
	}
	return notices;
}
