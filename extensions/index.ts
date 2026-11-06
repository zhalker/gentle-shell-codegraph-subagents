import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyCodegraphSubagents, readExposureWarning, readMissingServerWarning } from "../src/apply.ts";
import { prepareProject, runCodegraph, type SessionStartReason } from "../src/autoindex.ts";
import { exploreViaDaemon } from "../src/daemonclient.ts";
import { realInitLock } from "../src/initlock.ts";
import { chooseIndexNotice, firstPromptMessage, INDEX_NOTICE_MARKER, logPrefetch, noticeTools, type PrefetchOutcome } from "../src/index-notice.ts";
import { explorePerCase, prefetchForExplorer } from "../src/prefetch.ts";
import { warmUpDaemon } from "../src/warmup.ts";
import { chooseSkillReminder, SKILL_REMINDER_TYPE } from "../src/skill-reminder.ts";

// Starts the index sync (or first init) and then the daemon warm-up in the background; the session never waits for them.
function startAutoIndex(reason: SessionStartReason, ctx: ExtensionContext): void {
	const say = (text: string, level: "info" | "warning") => {
		if (ctx.hasUI) ctx.ui.notify(`gentle-shell-codegraph-subagents: ${text}`, level);
	};
	prepareProject({
		cwd: ctx.cwd,
		env: process.env,
		reason,
		exists: existsSync,
		run: runCodegraph,
		lock: realInitLock,
		warm: (cwd) => warmUpDaemon(cwd),
		onStart: (action) => say(action === "init" ? "creating the CodeGraph index of this project..." : "syncing the CodeGraph index...", "info"),
		onIndexed: (result) => {
			if (result.joined) say("another session is creating the CodeGraph index of this project", "info");
			else if (!result.ok) say(`codegraph ${result.action} failed in ${ctx.cwd}`, "warning");
			else say(result.action === "init" ? "CodeGraph index created" : "CodeGraph index synced", "info");
		},
		onWarmStart: () => say("warming up CodeGraph...", "info"),
	})
		.then((result) => {
			if (result.warm === "ok") say("CodeGraph ready", "info");
			else if (result.warm === "failed") say(`CodeGraph warm-up failed in ${ctx.cwd}`, "warning");
		})
		.catch(() => {
			// The session may already be gone; nothing to report to.
		});
}

// Reapplied on every session start so a reinstall (pi install, gentle-shell install)
// or a gentle-ai sync that rewrote the agent files is corrected on the next launch.
export default function (pi: ExtensionAPI) {
	let firstPromptSeen = false;
	pi.on("session_start", async (event, ctx) => {
		startAutoIndex(event.reason, ctx);
		try {
			const { changed, errors } = applyCodegraphSubagents(getAgentDir());
			if (!ctx.hasUI) return;
			if (changed.length > 0) ctx.ui.notify(`gentle-shell-codegraph-subagents: updated ${changed.length} file(s)`, "info");
			if (errors.length > 0) ctx.ui.notify(`gentle-shell-codegraph-subagents: ${errors.length} file(s) skipped: ${errors[0]}`, "warning");
			const registered = pi.getMcpServers?.().some((server) => server.name === "codegraph") ?? false;
			if (process.env.GENTLE_PI_AGENTS_CHILD !== "1" && readMissingServerWarning(getAgentDir(), ctx.cwd, ctx.isProjectTrusted(), registered)) {
				ctx.ui.notify("gentle-shell-codegraph-subagents: CodeGraph MCP server was not found in the current configuration. Subagents may not have direct access; configure the server to enable it.", "warning");
			}
			const exposure = readExposureWarning(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
			if (exposure === "hidden-with-direct") ctx.ui.notify("gentle-shell-codegraph-subagents: CodeGraph server is hidden, but its direct explore exception is configured to expose that tool. Your settings were preserved.", "warning");
			else if (exposure) ctx.ui.notify(`gentle-shell-codegraph-subagents: CodeGraph explore is configured as ${exposure}; direct subagent access may be unavailable. Your setting was preserved.`, "warning");
		} catch {
			// Never block a session over this.
		}
	});

	// First prompt of a session: the skill reminder and, when there is an index, the notice that says so.
	// Only the explorer child: hand it the CodeGraph answer for its task before its first model call.
	// With no index, no daemon or too slow a daemon, nothing is added and the daemon warm-up starts on its own.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const isUserPrompt = event.messageType === "user";
			const child = process.env.GENTLE_PI_AGENTS_CHILD === "1";
			const branch = ctx.sessionManager.getBranch();
			const alreadySent = firstPromptSeen || branch.some((entry) => entry.type === "custom_message" && entry.customType === SKILL_REMINDER_TYPE);
			const reminder = chooseSkillReminder({
				expectedPath: join(import.meta.dirname, "..", "skills", "codegraph-workflow", "SKILL.md"),
				skills: event.systemPromptOptions?.skills ?? [],
				child,
				systemPrompt: event.systemPrompt,
				alreadySent,
				isUserPrompt,
			});
			const notice = chooseIndexNotice({
				cwd: ctx.cwd,
				selectedTools: noticeTools(event.systemPromptOptions?.selectedTools ?? [], process.env.GENTLE_PI_AGENTS_REQUESTED_TOOLS, child),
				isUserPrompt,
				alreadySent: branch.some((entry) =>
					entry.type === "custom_message" && typeof entry.content === "string" && entry.content.includes(INDEX_NOTICE_MARKER)),
			});
			if (isUserPrompt) firstPromptSeen = true;
			const prompt = isUserPrompt ? event.prompt : undefined;
			// Whatever the prefetch answers, its outcome goes to the log; a prompt never waits for it.
			let outcome: PrefetchOutcome | undefined;
			const started = Date.now();
			const content = await prefetchForExplorer({
				env: process.env,
				prompt,
				cwd: ctx.cwd,
				exists: existsSync,
				initRunning: (cwd) => {
					const held = realInitLock.isHeld(cwd);
					if (held) outcome = "skipped-init-running";
					return held;
				},
				explore: async (query, cwd) => {
					const result = await explorePerCase(query, cwd, {
						daemon: (q, c, timeoutMs) => exploreViaDaemon(c, q, timeoutMs),
						warm: (c) => warmUpDaemon(c, undefined, { background: true }),
					});
					outcome = result.outcome;
					return result.text;
				},
			});
			if (outcome !== undefined) logPrefetch({ cwd: ctx.cwd, outcome, ms: Date.now() - started });
			const message = firstPromptMessage({ notice, reminder, prefetch: content, child });
			return message === undefined ? undefined : { message };
		} catch {
			return undefined;
		}
	});
}
