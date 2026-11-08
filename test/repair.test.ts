import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAgentV010, normalizeAgentV020ToV060 } from "../src/legacy-agents.ts";
import { PENDING_SUFFIX, repairFrozenAgentFiles, repairNotices, settleAgentFileRepairs } from "../src/repair.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "repair");
const BACKUP_SUFFIX = ".pre-codegraph-subagents.bak";
const STATE = join("codegraph-subagents", "repair-state.json");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// The same rule gentle-pi uses: the text from the frontmatter's closing line on.
function agentBody(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const end = content.indexOf("\n---", 4);
	return end === -1 ? content : content.slice(end);
}

const shippedText = (name: string): string => readFileSync(join(FIXTURES, "shipped", name), "utf8");
const derivedText = (name: string): string => readFileSync(join(FIXTURES, "derived", name), "utf8");
const fixtureModels = (): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, "models.json"), "utf8"));

/** The history gentle-pi ships for the synthetic fixture agents. */
function shippedBodies(): Record<string, string[]> {
	const bodies: Record<string, string[]> = {};
	for (const name of readdirSync(join(FIXTURES, "shipped"))) {
		bodies[`agents/${name}`] = [sha256(agentBody(shippedText(name)))];
	}
	return bodies;
}

interface Options {
	/** serialized package.json of the gentle-pi stub, or null to leave it out. */
	pkg?: string | null;
	/** serialized history, or null to leave it out. */
	history?: string | null;
	/** serialized models.json of gentle-pi's config home, or null to leave it out. */
	models?: string | null;
	manifest?: Record<string, string>;
	/** agent files to write, by file name. */
	agents?: Record<string, string>;
}

function setup(t: TestContext, options: Options = {}): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pcs-repair-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	mkdirSync(join(agentDir, "agents"));
	const piDir = join(agentDir, "npm", "node_modules", "gentle-pi");
	mkdirSync(join(piDir, "assets", "migrations"), { recursive: true });
	if (options.pkg !== null) writeFileSync(join(piDir, "package.json"), options.pkg ?? JSON.stringify({ name: "gentle-pi" }));
	if (options.history !== null) {
		writeFileSync(join(piDir, "assets", "migrations", "agent-body-history.json"), options.history ?? JSON.stringify({ schemaVersion: 1, bodies: shippedBodies() }));
	}
	mkdirSync(join(agentDir, "gentle-ai"), { recursive: true });
	writeFileSync(join(agentDir, "gentle-ai", "managed-assets.json"), JSON.stringify({ schemaVersion: 1, assets: options.manifest ?? {} }));
	if (options.models !== null) {
		mkdirSync(join(agentDir, ".pi", "gentle-ai"), { recursive: true });
		writeFileSync(join(agentDir, ".pi", "gentle-ai", "models.json"), options.models ?? JSON.stringify(fixtureModels()));
	}
	for (const [name, content] of Object.entries(options.agents ?? {})) writeFileSync(join(agentDir, "agents", name), content);
	return agentDir;
}

const FROZEN = "jd-judge-a.frozen-v0.6.0.md";
const BACKUP = "jd-judge-a.backup.md";

/** A frozen judge and its backup, as a published version of this extension left them. */
const frozenJudge = (content = derivedText(FROZEN)): Record<string, string> => ({
	"jd-judge-a.md": content,
	[`jd-judge-a.md${BACKUP_SUFFIX}`]: derivedText(BACKUP),
});

const repair = (agentDir: string, env: Record<string, string> = {}) => repairFrozenAgentFiles({ agentDir, home: agentDir, env });

const read = (agentDir: string, name: string): string => readFileSync(join(agentDir, "agents", name), "utf8");
const listing = (agentDir: string): string[] => readdirSync(join(agentDir, "agents")).sort();
const reasons = (notes: { reason: string }[]): string => notes.map((note) => note.reason).join(" | ");

test("S8: the frozen normalizers still recognise what 0.1.0 and 0.2.0-0.6.0 wrote", () => {
	// A fixture pair derived by running the frozen normalizer on a synthetic shipped body.
	assert.equal(normalizeAgentV020ToV060(derivedText(BACKUP)), derivedText(FROZEN));
	assert.equal(normalizeAgentV010(derivedText(BACKUP)), derivedText(FROZEN));
	// 0.1.0 and 0.2.0-0.6.0 differ on the worker alone: only the later one appended the marker.
	assert.equal(normalizeAgentV020ToV060(derivedText("gentle-ai-worker.backup.md")), derivedText("gentle-ai-worker.frozen-v0.6.0.md"));
	assert.equal(normalizeAgentV010(derivedText("gentle-ai-worker.backup.md")), derivedText("gentle-ai-worker.frozen-v0.1.0.md"));
	assert.notEqual(derivedText("gentle-ai-worker.frozen-v0.1.0.md"), derivedText("gentle-ai-worker.frozen-v0.6.0.md"));
});

test("S8: with no gentle-pi in the agent dir nothing is touched and the reason is reported", (t) => {
	const agentDir = setup(t, { pkg: null, agents: frozenJudge() });
	const before = listing(agentDir);
	const outcome = repair(agentDir);
	assert.deepEqual(outcome.repaired, []);
	assert.deepEqual(listing(agentDir), before);
	assert.match(reasons(outcome.skipped), /gentle-pi was not found/);
});

test("S8: a package.json of another package is not gentle-pi, and nothing is touched", (t) => {
	const agentDir = setup(t, { pkg: JSON.stringify({ name: "another-package" }), agents: frozenJudge() });
	const before = listing(agentDir);
	repair(agentDir);
	assert.deepEqual(listing(agentDir), before);
});

test("S8: without a readable body history nothing is touched and the reason names it", (t) => {
	const agentDir = setup(t, { history: null, agents: frozenJudge() });
	const before = listing(agentDir);
	const outcome = repair(agentDir);
	assert.deepEqual(listing(agentDir), before);
	assert.match(reasons(outcome.skipped), /agent-body-history\.json is missing or unreadable/);
});

test("S8: a body history of another shape is not read as a gentle-pi history", (t) => {
	const agentDir = setup(t, { history: JSON.stringify({ schemaVersion: 2, bodies: shippedBodies() }), agents: frozenJudge() });
	const before = listing(agentDir);
	repair(agentDir);
	assert.deepEqual(listing(agentDir), before);
});

test("S10 condition 1: a file with no backup is left alone and reported", (t) => {
	const agentDir = setup(t, { agents: { "jd-judge-a.md": derivedText(FROZEN) } });
	const outcome = repair(agentDir);
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md"]);
	assert.equal(read(agentDir, "jd-judge-a.md"), derivedText(FROZEN));
	assert.match(reasons(outcome.skipped), /has no \.pre-codegraph-subagents\.bak/);
});

test("S10 condition 1: a backup whose body gentle-pi never shipped is not repaired from", (t) => {
	const agentDir = setup(t, {
		agents: { "jd-judge-a.md": derivedText(FROZEN), [`jd-judge-a.md${BACKUP_SUFFIX}`]: "---\nname: jd-judge-a\ntools:\n  - read\n---\n\nYou are mine.\n" },
	});
	const outcome = repair(agentDir);
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md", `jd-judge-a.md${BACKUP_SUFFIX}`].sort());
	assert.match(reasons(outcome.skipped), /backup is not a body gentle-pi ships/);
});

test("S10 condition 2: content no published version wrote is left alone", (t) => {
	const edited = derivedText(FROZEN).replace("Report findings with the evidence you observed", "Report findings however you like");
	const agentDir = setup(t, { agents: frozenJudge(edited) });
	const outcome = repair(agentDir);
	assert.equal(read(agentDir, "jd-judge-a.md"), edited);
	assert.equal(existsSync(join(agentDir, "agents", `jd-judge-a.md${PENDING_SUFFIX}`)), false);
	assert.match(reasons(outcome.skipped), /neither a published version of this extension nor gentle-pi itself wrote its content/);
});

test("S10 condition 3: routing that models.json does not save is left alone", (t) => {
	const rerouted = derivedText(FROZEN).replace("model: fixture/judge-model", "model: handwritten/model");
	const agentDir = setup(t, { agents: frozenJudge(rerouted) });
	const outcome = repair(agentDir);
	assert.equal(read(agentDir, "jd-judge-a.md"), rerouted);
	assert.match(reasons(outcome.skipped), /its model is not the one saved in models\.json/);
});

test("S10 condition 3: routing with no models.json entry is left alone, and a missing models.json counts as none", (t) => {
	const withoutJudge = JSON.stringify({ "gentle-ai-worker": { model: "fixture/worker-model", thinking: "high" } });
	for (const models of [withoutJudge, null]) {
		const agentDir = setup(t, { models, agents: frozenJudge() });
		const outcome = repair(agentDir);
		assert.equal(read(agentDir, "jd-judge-a.md"), derivedText(FROZEN));
		assert.match(reasons(outcome.skipped), /its model is not the one saved in models\.json/);
	}
});

test("S8: a repairable file is swapped to the pending name, and its backup is byte-identical afterwards", (t) => {
	const agentDir = setup(t, { agents: frozenJudge() });
	const outcome = repair(agentDir);
	assert.deepEqual(outcome.repaired.map((note) => note.file), [join(agentDir, "agents", "jd-judge-a.md")]);
	// Only the pending copy appeared: no new backup, and the frozen copy is gone under its own name.
	assert.deepEqual(listing(agentDir), [`jd-judge-a.md${BACKUP_SUFFIX}`, `jd-judge-a.md${PENDING_SUFFIX}`].sort());
	assert.equal(read(agentDir, `jd-judge-a.md${PENDING_SUFFIX}`), derivedText(FROZEN));
	assert.equal(read(agentDir, `jd-judge-a.md${BACKUP_SUFFIX}`), derivedText(BACKUP));
});

test("S8 condition 2: a file whose body is a shipped body is repairable even when no normalizer produced it", (t) => {
	// gentle-pi refreshed the body, an older version of this package then edited the frontmatter and froze it.
	const edited = shippedText("gentle-ai-verify.md").replace("  - bash\n", "  - bash\n  - codegraph\n");
	const agentDir = setup(t, {
		agents: { "gentle-ai-verify.md": edited, [`gentle-ai-verify.md${BACKUP_SUFFIX}`]: derivedText("gentle-ai-verify.backup.md") },
	});
	const outcome = repair(agentDir);
	assert.equal(existsSync(join(agentDir, "agents", "gentle-ai-verify.md")), false);
	assert.equal(read(agentDir, `gentle-ai-verify.md${PENDING_SUFFIX}`), edited);
	assert.equal(outcome.repaired.length, 1);
});

test("S8 condition 2: a trailing worker marker does not hide a shipped body", (t) => {
	// 0.6.0 appended the marker to the worker after gentle-pi had refreshed its body.
	const edited = shippedText("gentle-ai-worker.md").replace("  - edit\n", "  - edit\n  - codegraph\n") + "\n<!-- codegraph-workflow:worker -->\n";
	const agentDir = setup(t, {
		agents: { "gentle-ai-worker.md": edited, [`gentle-ai-worker.md${BACKUP_SUFFIX}`]: derivedText("gentle-ai-worker.backup.md") },
	});
	repair(agentDir);
	assert.equal(existsSync(join(agentDir, "agents", "gentle-ai-worker.md")), false);
	assert.equal(read(agentDir, `gentle-ai-worker.md${PENDING_SUFFIX}`), edited);
});

test("S8: a file gentle-pi still manages was never frozen and is left alone", (t) => {
	const agentDir = setup(t, { agents: frozenJudge(), manifest: { "agents/jd-judge-a.md": sha256(derivedText(FROZEN)) } });
	const outcome = repair(agentDir);
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md", `jd-judge-a.md${BACKUP_SUFFIX}`].sort());
	assert.equal(read(agentDir, "jd-judge-a.md"), derivedText(FROZEN));
	assert.deepEqual(outcome, { repaired: [], settled: [], skipped: [] });
});

test("S11: settling removes the pending copy when gentle-pi recreated the file", (t) => {
	const recreated = shippedText("jd-judge-a.md");
	const agentDir = setup(t, {
		agents: {
			"jd-judge-a.md": recreated,
			[`jd-judge-a.md${PENDING_SUFFIX}`]: derivedText(FROZEN),
			[`jd-judge-a.md${BACKUP_SUFFIX}`]: derivedText(BACKUP),
		},
	});
	const outcome = settleAgentFileRepairs({ agentDir, env: {} });
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md", `jd-judge-a.md${BACKUP_SUFFIX}`].sort());
	assert.equal(read(agentDir, "jd-judge-a.md"), recreated);
	assert.equal(outcome.settled.length, 1);
	assert.match(outcome.settled[0].reason, /recreated the file/);
});

test("S11: settling restores the exact original bytes when gentle-pi did not recreate the file, and it is not retried", (t) => {
	const agentDir = setup(t, { agents: { [`jd-judge-a.md${PENDING_SUFFIX}`]: derivedText(FROZEN), [`jd-judge-a.md${BACKUP_SUFFIX}`]: derivedText(BACKUP) } });
	const settled = settleAgentFileRepairs({ agentDir, env: {} });
	assert.equal(read(agentDir, "jd-judge-a.md"), derivedText(FROZEN));
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md", `jd-judge-a.md${BACKUP_SUFFIX}`].sort());
	assert.match(settled.settled[0].reason, /restored and will not be retried/);
	assert.ok(existsSync(join(agentDir, STATE)), "the rollback is recorded");

	const again = repair(agentDir);
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md", `jd-judge-a.md${BACKUP_SUFFIX}`].sort());
	assert.match(reasons(again.skipped), /a rollback already tried it and nothing changed since/);
});

test("S11: settling never overwrites a file that exists", (t) => {
	const agentDir = setup(t, { agents: { "jd-judge-a.md": "---\nname: mine\n---\n\nMine.\n", [`jd-judge-a.md${PENDING_SUFFIX}`]: derivedText(FROZEN) } });
	settleAgentFileRepairs({ agentDir, env: {} });
	assert.equal(read(agentDir, "jd-judge-a.md"), "---\nname: mine\n---\n\nMine.\n");
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md"]);
});

test("S11: a load that finds a fresh pending copy with the file missing leaves it alone and records nothing", (t) => {
	const agentDir = setup(t, { agents: frozenJudge() });
	repair(agentDir);
	// gentle-pi's own startup install has not run in this process yet, so a missing file proves nothing.
	const second = repair(agentDir);
	assert.doesNotMatch(reasons(second.skipped), /could not/);
	assert.deepEqual(second.repaired, []);
	assert.deepEqual(listing(agentDir), [`jd-judge-a.md${BACKUP_SUFFIX}`, `jd-judge-a.md${PENDING_SUFFIX}`].sort());
	assert.equal(read(agentDir, `jd-judge-a.md${PENDING_SUFFIX}`), derivedText(FROZEN));
	assert.equal(existsSync(join(agentDir, STATE)), false);
	assert.match(reasons(second.skipped), /waiting for gentle-pi to recreate it/);
});

test("S11: the first-prompt settle rolls a pending copy back to the exact bytes and records no retry", (t) => {
	const agentDir = setup(t, { agents: frozenJudge() });
	repair(agentDir);
	repair(agentDir);
	// Only after this process's startup install had its chance: gentle-pi did not recreate the file.
	const settled = settleAgentFileRepairs({ agentDir, env: {} });
	assert.equal(read(agentDir, "jd-judge-a.md"), derivedText(FROZEN));
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md", `jd-judge-a.md${BACKUP_SUFFIX}`].sort());
	assert.match(settled.settled[0].reason, /restored and will not be retried/);
	assert.ok(existsSync(join(agentDir, STATE)));
	const again = repair(agentDir);
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md", `jd-judge-a.md${BACKUP_SUFFIX}`].sort());
	assert.match(reasons(again.skipped), /a rollback already tried it and nothing changed since/);
});

test("S11: a load that finds the file recreated and a pending copy removes the pending copy", (t) => {
	const recreated = shippedText("jd-judge-a.md");
	const agentDir = setup(t, {
		agents: {
			"jd-judge-a.md": recreated,
			[`jd-judge-a.md${PENDING_SUFFIX}`]: derivedText(FROZEN),
			[`jd-judge-a.md${BACKUP_SUFFIX}`]: derivedText(BACKUP),
		},
		manifest: { "agents/jd-judge-a.md": sha256(recreated) },
	});
	const outcome = repair(agentDir);
	assert.deepEqual(listing(agentDir), ["jd-judge-a.md", `jd-judge-a.md${BACKUP_SUFFIX}`].sort());
	assert.equal(read(agentDir, "jd-judge-a.md"), recreated);
	assert.equal(outcome.settled.length, 1);
	assert.match(outcome.settled[0].reason, /recreated the file/);
	assert.deepEqual(outcome.repaired, []);
});

test("S8: GENTLE_PI_AGENT_HOME naming another directory skips the whole repair", (t) => {
	const agentDir = setup(t, { agents: frozenJudge() });
	const elsewhere = mkdtempSync(join(tmpdir(), "pcs-repair-home-"));
	t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
	const before = listing(agentDir);
	const env = { GENTLE_PI_AGENT_HOME: elsewhere };
	const outcome = repair(agentDir, env);
	assert.deepEqual(listing(agentDir), before);
	assert.match(reasons(outcome.skipped), /GENTLE_PI_AGENT_HOME/);
	assert.equal(existsSync(join(agentDir, STATE)), false);
	assert.deepEqual(settleAgentFileRepairs({ agentDir, env }).settled, []);
	// The same directory under another spelling is this agent dir: the repair runs.
	assert.equal(repair(agentDir, { GENTLE_PI_AGENT_HOME: `${agentDir}/.` }).repaired.length, 1);
});

test("S8: a subagent child repairs and settles nothing", (t) => {
	const agentDir = setup(t, {
		agents: {
			...frozenJudge(),
			"review-risk.md": "---\nname: review-risk\n---\n\nReview.\n",
			["review-risk.md" + PENDING_SUFFIX]: "---\nname: review-risk\n---\n\nOlder review.\n",		},
	});
	const before = listing(agentDir);
	const child = { GENTLE_PI_AGENTS_CHILD: "1" };
	const outcome = repair(agentDir, child);
	assert.deepEqual(listing(agentDir), before);
	assert.deepEqual(outcome.repaired, []);
	assert.deepEqual(outcome.settled, []);
	assert.match(reasons(outcome.skipped), /subagent child never repairs/);
	const settled = settleAgentFileRepairs({ agentDir, env: child });
	assert.deepEqual(listing(agentDir), before);
	assert.deepEqual(settled.settled, []);
});

test("S8: every repaired and skipped file is reported with its reason for the session-start notification", (t) => {
	const agentDir = setup(t, { agents: { "jd-judge-a.md": derivedText(FROZEN) } });
	const notices = repairNotices(repair(agentDir));
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "warning");
	assert.match(notices[0].text, /jd-judge-a\.md: it has no \.pre-codegraph-subagents\.bak to repair it from/);
	assert.deepEqual(repairNotices(undefined), []);
});
