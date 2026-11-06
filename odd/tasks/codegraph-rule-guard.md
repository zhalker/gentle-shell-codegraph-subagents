# Guard the index against conflicting CodeGraph rules (0.5.0)
Users' AGENTS.md files can ask the model to run `codegraph init`, `index` or `sync` before every use, which fights the extension (rebuilt index, stopped daemon, parallel runs) and makes it look broken. Block the rebuild and tell the user once per project.
Branch: `feat/codegraph-rule-guard` from `main` (8c8bdce, 0.4.0). Release: 0.5.0, published to npm by the user (0.4.0 is skipped on npm).

## Specs

- S1. "me gusta e 2 pero solo lo de bloquear el index con indice ya existente". When the model runs `codegraph index` through a shell tool in a project that already has a CodeGraph index, the extension blocks the call and tells the model why and what to do instead. `codegraph init` and `codegraph sync` are not blocked.
- S2. Escape hatch, user answer "1. si" to: "¿El bloqueo de `index` lleva vía de escape? Por ejemplo, `CODEGRAPH_SUBAGENTS_ALLOW=1 codegraph index`". A command carrying `CODEGRAPH_SUBAGENTS_ALLOW=1` is never blocked, and the block reason names it.
- S3. "un cambio de ultimo momento, no mostraremos el mensaje de conflicto, lo otro si". Do not detect or display the conflict warning or store its per-project state.
- S4. Superseded by S3: "2. una vez por proyecto".
- S5. The pre-fetch header no longer says it ran `codegraph explore`; it was answered by the project's CodeGraph daemon (since 0.3.0).
- S6. "si, estoy de acuerdo que iria en la 0.5.0 y seria la 0.5.0 la que publicaria directamente en NPM, el 4 se salta". Version 0.5.0, docs, tag `v0.5.0` and GitHub release; the user publishes to npm.

## Tasks

- [x] T1 | S1 S2 S3 S5 | worker | Retain index guard and pre-fetch header; remove conflict warning and its state. | 6c6bed6 (initial); removal in subsequent commit
- [-] T2 | S3 S4 | dropped | Conflict warning withdrawn by user.
- [ ] T3 | S6 | inline | README and known limits, full suite, load smoke, PR, 0.5.0, tag and release.

## Log

- L1. Origin (2026-11-06): a user's global AGENTS.md said, verbatim: "if no .codegraph folder exists, initialize the project by running "codegraph init" and "codegraph index" first, then query; ALWAYS refresh the index by running "codegraph sync" before any use or call to codegraph so searches run against the most updated data". Their `.codegraph/` before and after a reindex showed `daemon.sock`, the WAL files and `writer.pid` gone afterwards: the rebuild stopped the daemon.
- L2. User, verbatim: "Antes de decirle algo a la usuaria..., la cosa es que muchas personas podrian tener un AGENTS.md de uno u otro modo y entrar en conflicto con la extension, pensar que no sirve la extension y descartarla...., ¿hay algo que podamos hacer en la extension para el segundo y tercero de la tabla y evitar que se cuelgue o rompa algo?"
- L3. A customizable rules catalog was proposed and dropped by the user, verbatim: "nada, estoy con dudas asi que vamos a lo seguro...lo que teniamos antes."
- L4. User, verbatim: "me gusta e 2 pero solo lo de bloquear el index con indice ya existente, el 3....yo mostraria el mensaje e indicaria las razones y consecuencias de mantenerse el conflicto pero lo mostraria solo una unica vez por proyecto pero...¿es posible saber donde esta su AGENTS.md global y su AGENTS.md local? supongo que si no? para linux o mac o windows / y si, estoy de acuerdo que iria en la 0.5.0 y seria la 0.5.0 la que publicaria directamente en NPM, el 4 se salta". Then: "1. si 2. una vez por proyecto 3. si".
- L5. Pi 1.5.0 facts: `tool_call` fires before a tool runs, `event.input.command` holds a bash command, and returning `{ block: true, reason }` blocks it (docs/extensions.md:971-1003). The loaded context files, global and from the cwd and its parents, arrive as `systemPromptOptions.contextFiles` with `path` and `content` (docs/configuration.md:18,41-45; extensions.md:1322-1331; dist/core/system-prompt.d.ts:30-33); their content is sensitive and is never logged or stored.
- L6. Design: the guard checks `bash` and `bash_background` commands for `codegraph index` (as a command word, `npx` included) and blocks when the cwd, or a path given right after `index`, has an index; a `cd` inside the command is not followed (heuristic, the escape hatch covers it). The conflict detector splits each file into sentences (a dot followed by whitespace, `;`, line breaks); a sentence conflicts when it runs `codegraph index`, or runs `codegraph init`/`sync` with "always", "before any/every/each" or "every/each time", and is not negated ("do not", "don't", "never", "avoid"). The warning goes out on the first user prompt of a main session with a UI; shown projects are recorded by canonical root in `~/.pi/agent/codegraph-subagents/conflict-notices.json`.
- L7. Evidence for T1-T2 (before L8): RED was the missing module, and S5 failed alone against the old header. GREEN: `test/codegraph-guard.test.ts` 10/10, `npm test` 244/244. End to end in an isolated RPC Pi 1.5.0 with a local fake OpenAI-compatible model that asks for `bash` `codegraph index` in a project with `.codegraph/codegraph.db`: the call ended `isError=true` with the block reason, and an `AGENTS.md` rule "ALWAYS ... \"codegraph sync\" before any use" in the agent dir produced one warning naming that file. A second session in the same project showed no warning, and `conflict-notices.json` held only the folded project root.
- L8. User correction: "un cambio de ultimo momento, no mostraremos el mensaje de conflicto, lo otro si". The warning, its detection and persistent state are withdrawn; retain the guard and pre-fetch correction.
- L9. Removal: focused tests 7/7; full suite 241/241. Isolated Pi RPC smoke with a conflicting AGENTS.md: index command blocked, no conflict warning, no notice-state file.
