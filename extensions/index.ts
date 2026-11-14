import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readExposureWarning, readMissingServerWarning } from "../src/apply.ts";
import { agentNameFromArgv, codegraphTools, sessionIndexRole } from "../src/agents.ts";
import { linkedWorktrees, prepareProject, runCodegraph, seedLinkedWorktrees, syncAfterNativeInit, type SessionStartReason } from "../src/autoindex.ts";
import { compactionSync, realSyncLock } from "../src/compaction-sync.ts";
import { appendCodegraphSection, codegraphSection } from "../src/codegraph-rules.ts";
import { codegraphWritingIndex, isInitLocked, realInitLock } from "../src/initlock.ts";
import { findIndexRoot, indexOutcomeNotice, indexStartNotice, initHookDecision, logSync, noticeTools, postInitSyncNotice, warmOutcomeNotice} from "../src/index-notice.ts";
import { warmUpDaemon } from "../src/warmup.ts";
import { repairFrozenAgentFiles, repairNotices, settleAgentFileRepairs, type RepairOutcome } from "../src/repair.ts";

// The repair never throws into extension loading or into a prompt: a failed repair is simply no repair.
function safeRepair(run: () => RepairOutcome): RepairOutcome | undefined {
	try {
		return run();
	} catch {
		return undefined;
	}
}

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
		sync: realSyncLock,
		warm: (cwd) => warmUpDaemon(cwd),
		onStart: (action) => say(indexStartNotice(action), "info"),
		onIndexed: (result) => {
			const notice = indexOutcomeNotice(result, ctx.cwd);
			say(notice.text, notice.level);
		},
		onWarmStart: () => say("warming up CodeGraph...", "info"),
	})
		.then((result) => {
			if (result.warm === "skipped") return;
			const notice = warmOutcomeNotice(result.warm, ctx.cwd);
			say(notice.text, notice.level);
		})
		.catch(() => {
			// The session may already be gone; nothing to report to.
		});
}

/** The linked worktrees of this repository, as one short `git worktree list` reports them. */

/**
 * Seeds this repository's unindexed linked worktrees in the background, so the index exists before the first
 * subagent child is handed one. Every seed takes the worktree's own index lock: a worktree another session is
 * writing is left alone instead of being copied into, whatever the other writer is doing.
 */
function seedSessionWorktrees(ctx: ExtensionContext): void {
	void Promise.resolve().then(() => {
		const started = Date.now();
		const result = seedLinkedWorktrees({
			worktrees: linkedWorktrees({ cwd: ctx.cwd }),
			lock: realInitLock,
			exists: existsSync,
			sourceBusy: (root) => isInitLocked(root) || codegraphWritingIndex(root),
			copy: (from, to) => {
				try { copyFileSync(from, to); return true; } catch { return false; }
			},
		});
		// Nothing is announced: a worktree that cannot be seeded costs nothing. A seed that did not happen for a
		// coordination reason or a failed copy is still recorded, so it can be diagnosed.
		for (const entry of result.skipped) {
			if (entry.reason === "already has an index") continue;
			logSync({ cwd: entry.worktree, outcome: `seed-skipped: ${entry.reason}`, ms: Date.now() - started });
		}
	}).catch(() => {});
}

export default function (pi: ExtensionAPI) {
	// Runs at load, before gentle-pi's own startup install: a frozen agent file is moved aside here, so that
	// install recreates it from its assets and manages it again. A subagent child repairs nothing.
	const loadRepair = process.env.GENTLE_PI_AGENTS_CHILD === "1" ? undefined : safeRepair(() => repairFrozenAgentFiles({ agentDir: getAgentDir(), home: homedir(), env: process.env }));
	const notifyRepair = (ctx: ExtensionContext, outcome: RepairOutcome | undefined) => {
		if (!ctx.hasUI) return;
		for (const notice of repairNotices(outcome)) ctx.ui.notify(`gentle-shell-codegraph-subagents: ${notice.text}`, notice.level);
	};
	// The swap is settled once, on the first prompt of the parent session: gentle-pi's install has run by then.
	let swapSettled = false;
	pi.on("session_compact", (_event, ctx) => {
		// A long session's index is only as fresh as its last sync, so a compaction asks for one in the
		// background: never an init, never a notification, and its result goes to sync.log.
		void compactionSync({
			cwd: ctx.cwd,
			env: process.env,
			exists: existsSync,
			lock: realInitLock,
			sync: realSyncLock,
			run: runCodegraph,
			log: (entry) => logSync(entry),
		});
	});

	// A native `codegraph init` is observed, never replaced: this package registers no tool, shadows nothing and
	// depends on no load order. After a successful init it asks its own coordination for one sync and appends that
	// outcome to the tool's own result. A failed init keeps its original error and triggers nothing, and the hook
	// never makes the call fail: Pi catches a throwing handler (extensions.md, tool_result).
	pi.on("tool_result", async (event, ctx) => {
		try {
			const role = sessionIndexRole(process.env);
			const decision = initHookDecision(event, role);
			if (decision === "skip-not-a-native-init" || decision === "skip-failed-init") return undefined;
			const outcome = decision === "skip-read-only"
				? ("skipped-read-only" as const)
				: await syncAfterNativeInit({
					cwd: ctx.cwd,
					exists: existsSync,
					lock: realInitLock,
					sync: realSyncLock,
					run: runCodegraph,
					role,
					log: (entry) => logSync(entry),
				});
			return { content: [...event.content, { type: "text" as const, text: postInitSyncNotice(outcome) }] };
		} catch {
			// A hook that cannot work appends nothing: the tool result stays exactly as it came back.
			return undefined;
		}
	});

	pi.on("session_start", async (event, ctx) => {
		startAutoIndex(event.reason, ctx);
		// Seed the session repo's unindexed worktrees in the background, so the index exists before the first
		// subagent child is handed one. Never waits, never announces: a skipped worktree costs nothing.
		if (event.reason !== "reload") seedSessionWorktrees(ctx);
		// The precise hook, when it exists: gentle-pi emits its session worktree registry event on Pi's shared
		// extension event bus every time a worktree joins the session's working set (explicit register today).
		// Subscribing here makes seeding event-driven instead of scan-driven. The channel is still gentle-pi's
		// internal constant (see zh_lia/issues/gentle-shell-worktree-registry-event.md): a refactor that renames
		// it must only degrade to the scan above, never break the session, so both the string and the payload
		// are read defensively and the subscription is best-effort.
		try {
			const unsubscribeWorktreeEvent = pi.events?.on?.("gentle-pi:session-worktree-changed", (payload: unknown) => {
				try {
					const e = payload as { sessionId?: unknown } | undefined;
					if (!e || e.sessionId !== ctx.sessionManager.getSessionId()) return;
					seedSessionWorktrees(ctx);
				} catch { /* a failed event-driven seed just falls back to the next scan */ }
			});
			if (typeof unsubscribeWorktreeEvent === "function") pi.on("session_shutdown", () => unsubscribeWorktreeEvent());
		} catch { /* without the bus the scan at session start still covers every worktree it sees */ }
		try {
			// No agent file and no mcp.json is written: gentle-pi ships the CodeGraph MCP tool, and these two reads
			// only warn when the shipped tool cannot be reached in the current configuration.
			notifyRepair(ctx, loadRepair);
			if (!ctx.hasUI) return;
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

	// Every run of a session that can call CodeGraph gets the text of its own role — the orchestrator's in the
	// primary session, the agent's in a gentle-shell child, and the generic one for any other child, which is also
	// what a file that cannot be read falls back to. It is appended to the prompt options, never returned as a
	// replacement prompt, and a session without a CodeGraph tool (a reviewer, for example) gets nothing. When the
	// checkout has an index, the section itself says so; there is no separate notice message.
	pi.on("before_agent_start", (event, ctx) => {
		try {
			const child = process.env.GENTLE_PI_AGENTS_CHILD === "1";
			if (!swapSettled) {
				swapSettled = true;
				if (!child) notifyRepair(ctx, safeRepair(() => settleAgentFileRepairs({ agentDir: getAgentDir(), env: process.env })));
			}
			const tools = noticeTools(event.systemPromptOptions?.selectedTools ?? [], process.env.GENTLE_PI_AGENTS_REQUESTED_TOOLS, child);
			const available = codegraphTools(tools).length > 0;
			appendCodegraphSection(event, codegraphSection({
				tools,
				child,
				agent: agentNameFromArgv(process.argv),
				root: available ? findIndexRoot(ctx.cwd) : undefined,
			}));
		} catch {
			// The loaded context files are not inspected: a conflicting rule is neither detected nor reported.
		}
	});
}
