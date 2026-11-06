# Port the office 0.2.0 patch
Bring the office local patch to 0.2.0 (handoff bundle kept outside the repository) into this repo, done properly, with its tests.
Branch: `feat/office-patch-port`, work-unit commits, no push or publish. Delivery: ask-on-risk. Runner: `npm test` (`node --test`).

## Specs

- S1. "lo que hicimos en la ofi nos lo traemos pero bien hecho": the local patch (paths identity, prefetch per case, background warm-up release, index notice and prefetch log) lands in `src/` and `extensions/`, re-derived against this repo rather than copied blindly. Source of truth: `0.2.0-local-patch.diff` and `AGENT-CONTEXT.md` section 4 of the bundle.
- S2. "integrar los tests, adaptar el que sea necesario": the bundle's 45 tests (`tests/zhalker-0.2.0-*.test.ts`) are integrated into `test/` next to the existing suites, importing the repo sources directly (no `CGS_PKG_DIR`, no copy to a temp dir); existing tests that pin removed behavior (the CLI prefetch path) are adapted. Tests check through the public interface of each module, not by reading source text.
- S3. "el 2 aprobado": the test script fails when it finds 0 tests.
- S4. "el 3 tambien": a UNC case is covered by tests.
- S5. "un documento de feature y commits por unidad en una rama sin publicar".
- Non-goal (agreed): the SMB gate (`GATE.md`) stays out; it is decided after the port.
- Assumption: no version bump; versioning and publishing stay the user's decision.

## Tasks

- [x] T1 | S1 S2 S4 | inline | commit: (this commit) | RED: old spawn ran a UNC project in C:\Windows; `a%OS%b` reached codegraph as `aWindows_NTb`. GREEN: `test/paths.test.ts` 19/19 (0 skipped: mapped Z: and \\localhost\c$), `npm test` 188/188. Risk: item 2 (shell command line built from a path). Paths: `src/paths.ts`, canonical root in `daemonclient`, registered spelling, codegraph spawned from the temp dir with the project as argument (`autoindex`, `warmup`), tests incl. UNC.
- [ ] T2 | S1 S2 | inline | Prefetch per case (10 s daemon, no CLI, background warm-up) and warm-up release; remove the CLI prefetch path; adapt `test/prefetch.test.ts` and `test/warmup.test.ts`.
- [ ] T3 | S1 S2 | inline | Index notice and prefetch log (`src/index-notice.ts`) wired in `extensions/index.ts`; tests.
- [ ] T4 | S3 | inline | Test script fails when 0 tests run.
- [ ] T5 | S1-S5 | inline | Docs (README, `docs/findings.md`), full suite, close.

## Log

- L1. User, verbatim (2026-11-05): "Vale, he vuelto de la oficina y ahi hice pruebas y mejoras a la 0.2.0 [local folder path removed] analiza toda la carpeta y dime que es y que hay de nuevo"
- L2. Parent proposal accepted: integrate the 45 tests into `test/` (adapting `prefetch.test.ts`), make the test script fail on 0 tests, add a UNC case; treat it as a large task with a feature document and work-unit commits on a branch, unpublished; the gate stays apart.
- L3. User, verbatim (2026-11-05): "Me parece bien tomarlo como tarea grande porque lo es, un documento de feature y commits por unidad en una rama sin publicar. Tambien estoy de acuerdo en integrar los tests, adaptar el que sea necesario, el 2 aprobado, el 3 tambien...o sea, lo que hicimos en la ofi nos lo traemos pero bien hecho. Arranca"
- L5. T1 findings: (a) with a UNC project the 0.2.0 spawn does not fail, cmd.exe runs `codegraph sync -q` in `C:\Windows`; (b) the office patch put the quoted project path in the cmd.exe command line, where `%VAR%` still expands (observed `a%OS%b` -> `aWindows_NTb`). Fix beyond the office patch: the path travels in `CODEGRAPH_SUBAGENTS_PROJECT` and the command line only references it (`"%VAR%"` / `"$VAR"`); `shellQuote` was removed. The two source-text tests of the bundle were replaced by behavioral tests with a fake `codegraph` that records cwd and arguments; UNC cases use any mapped drive or the admin share instead of a fixed `Y:`. Known limit: a registry-enabled cmd.exe DelayedExpansion would still expand `!VAR!`.
- L4. Evidence: the bundle's `package-0.2.0-orig/SHA256SUMS` checks OK against HEAD `5f0eb3e` (10 files); `package.json`, README and SKILL.md are identical, so the patched files apply without a manual merge. Forecast: about 700 authored changed lines over 5 tasks (above the ~400 slice budget; strategy asked when the count passes it).
