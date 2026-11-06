# Address the 0.3.0 review findings
Act on the ten informational findings of the native review of the published 0.2.0 -> 0.3.0 series (review-bf510d866576d3e7).
Branch: `fix/review-findings` from `main` (0.3.0), work-unit commits, PR into `main`. Runner: `npm test` (`node scripts/run-tests.mjs`).

## Specs

- S1. "tarea siguiente": each of the ten findings is diagnosed at its location and either fixed with a test, or closed with a written reason (no defect, or not worth changing). The review stored only id, lens, severity and location:
  - R1-001 risk WARNING `src/index-notice.ts:85-86`
  - R3-001 reliability SUGGESTION `src/index-notice.ts:84-86`
  - R3-002 reliability WARNING `src/index-notice.ts:109-117`
  - R3-003 reliability WARNING `src/paths.ts:30-36`
  - R3-004 reliability SUGGESTION `src/daemonclient.ts:79-81`
  - R3-005 reliability SUGGESTION `src/prefetch.ts:66-90`
  - R4-logformat resilience WARNING `src/index-notice.ts:86`
  - R4-notice-display resilience WARNING `src/index-notice.ts:120`
  - R4-pidreuse resilience WARNING `src/daemonclient.ts:76-80`
  - R4-timeoutheadroom resilience SUGGESTION `src/prefetch.ts:50-55`
- S2. Behavior that the findings do not touch stays as it is; existing tests keep passing.
- Non-goal: publishing; `npm publish` stays with the user.

## Tasks

- [x] T1 | S1 | delegated explore (mw4m78b2-8-7ag6, result in L4) | Diagnose every finding at its location: concrete failure, trigger, evidence, proposed fix or close reason.
- [x] T2 | S1 S2 | RED inline, GREEN worker mw4n5xga-1-dw5d (context backstop) | commits de7601d (G1 G3 G7), 8251dc3 (G5 G6 G8); evidence L6 | Fix the findings T1 confirms, test-first, grouped by file; close the rest with reasons in the Log.
- [ ] T3 | S1 S2 | inline | Docs if behavior changes, full suite, PR into `main`.

## Log

- L1. User, verbatim (2026-11-06), answering whether to file issues or do a next task for the ten findings: "4 tarea siguiente".
- L2. The review controller kept no finding text (`.git/gentle-ai/review-transactions` has 5 files, none mentions the ids), so T1 rebuilds each finding from its location, lens and severity.
- L3. User, verbatim (2026-11-06): "cuando termines el explorer, pausas para actualizar la propia extension que uso aqui". After T1 returns, record its result and stop before T2 until the user resumes.
- L4. T1 result (explore mw4m78b2-8-7ag6, code reading only), 10 ids in 8 groups:
  - G1 R1-001 + R4-logformat, `src/index-notice.ts:86`: `logPrefetch` writes `cwd` raw into a tab-separated line; a tab or newline in the name (legal on POSIX) splits or forges records. Confirmed. Fix: replace `[\t\r\n]` in `cwd`; test that each line keeps exactly 4 fields.
  - G2 R3-001, `src/index-notice.ts:84-86`: synchronous mkdir and append inside `before_agent_start`; a slow home directory stalls the first prompt, errors are swallowed by design. Plausible, sub-ms in practice. Fix async, or close.
  - G3 R3-002, `src/index-notice.ts:109-117`: the comment says reminder, notice, pre-fetch, but the content is notice, reminder, pre-fetch (pinned by `test/index-notice.test.ts`). Comment only.
  - G4 R4-notice-display, `src/index-notice.ts:120`: reminder-only message on the main session is hidden. Intended, documented and pinned. Close.
  - G5 R3-003, `src/paths.ts:30-36`: every realpath failure falls back to `resolve`, so EPERM/EACCES on an existing path breaks drive/UNC folding and can split daemons. Mechanism confirmed, trigger unproven. Fix: branch on `err.code`, injectable realpath for the test.
  - G6 R3-004 + R4-pidreuse, `src/daemonclient.ts:43-45,76-83`: dead registry records are never pruned and liveness is pid only; a reused pid makes a stale record win `registeredRoot`, its spelling reaches the CLI and can start a second daemon, and its socket is tried first. Mechanism confirmed, reuse unproven. Medium on Windows. Fix: corroborate liveness (start time or socket) and an injectable `alive` for the test.
  - G7 R3-005, `src/prefetch.ts:66-90`: an unexpected exception in the daemon path is logged as `skipped-no-daemon` (pinned by `test/prefetch-per-case.test.ts`). Fix: a `daemon-error` outcome, or close.
  - G8 R4-timeoutheadroom, `src/prefetch.ts:50-55` with `src/daemonclient.ts:103,154-157`: one 10 s timer covers connect, hello, initialize and explore, so the handshake eats the 1.6 s headroom over the slowest query; a silent first socket can starve the second. Plausible. Fix: separate handshake budget or a larger constant; test with the fake daemon.
  - Ranking from the explorer: fix G6, G1, G8, G5, G7, then G2 or close, G3 comment; close G4.
  - Paused here per L3.
- L5. User, verbatim (2026-11-06): "listo, ya tenemos la 0.3.0 que fue publicada instalada / aplica las correcciones". T2 design decisions:
  - G6: a record is alive only when its pid runs AND its socket is present. Windows named pipes (`\\.\pipe\name`) are checked by listing `\\.\pipe\` with `readdirSync` (probed: lists live pipes, drops closed ones, never connects to them; a failed listing counts as present); other paths with `existsSync`. Registry files belong to CodeGraph and are not pruned.
  - G5: when a path cannot be resolved (missing, EPERM, EACCES), `canonicalRoot` resolves its nearest resolvable parent and appends the rest, so links and mapped drives above it still fold and the identity does not move once the path appears.
  - G8: `DAEMON_HELLO_TIMEOUT_MS = 2_000` per socket; a silent socket gives way to the next one; when every socket failed and one of them was silent, the result is `timeout` (a daemon is there, warming again would not help). The 8375 ms calibration was an end-to-end prefetch, so the handshake is already inside it; the constant stays 10 s.
  - G1: control characters (U+0000-U+001F, U+007F) in the logged directory become `?`.
  - G7: a throwing daemon client logs `daemon-error`, still warms once.
  - G3: comment states type precedence (reminder, notice, pre-fetch) and content order (notice, reminder, pre-fetch).
  - Closed: G2 (one ~100-byte synchronous append, sub-millisecond, keeps lines ordered and never throws); G4 (intended, documented and pinned); the symlink-append angle of R1-001 (the log directory is the user's own; whoever can plant a link there can already write the user's files).
  - RED observed: the 6 new or changed tests fail on the unfixed code (65 tests, 59 pass, 6 fail).
- L6. T2 evidence: GREEN `npm test` 225/225, 0 skipped. The worker stopped on one older duplicate test (`test/daemonclient.test.ts`, throwing daemon client) that still expected `skipped-no-daemon`; the parent updated it to `daemon-error`. Differential check of `canonicalRoot` old vs new on 13 inputs (temp dir, case, trailing separator, missing paths, drive roots, `.`, `..`, cwd, an admin share, a missing path under it, an unmapped drive): 0 differences. Each commit passes its own focused tests (de7601d alone: 61/61). Risk: item 3 (shared `canonicalRoot` also keys the init lock), so an independent verify runs.
- L7. Independent verify mw4nhwi4-2-za66: pass with notes, no blockers. `npm test` 225/225 (mapped-drive test ran). Its own differential probe on 21 inputs (adds `C:/`, a missing share, a bare `\\localhost`, `Q:\`, `C:\Windows\..\`, `/`, forward-slash UNC): 0 differences. Every L5 item met. Notes: with a budget under 2 s the deadline timer fires first, so a silent socket reports `timeout` (same outcome); for an unresolvable path under a link or mapped drive the init-lock key now differs from 0.3.0, which is the intended G5 change and is pinned by the junction test; recursion depth equals the number of missing segments.
