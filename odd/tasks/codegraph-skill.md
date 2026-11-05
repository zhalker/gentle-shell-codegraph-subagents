# CodeGraph workflow skill
Package an approved CodeGraph workflow skill and inject first-prompt reminders.
The user's existing same-name skill must not be overwritten.

## Specs

- S1. "Vamos a crear una skill para codegraph con el contenido de la imagen pero habra que evaluar si el contenido tiene sentido y es viable."
- S2. "La skill se crea cuando se instala la extension. Si existe ya una skill con el mismo nombre, se avisa al instalar."
- S3. "Despues, en el primer prompt de la sesion, se inyecta que se debe usar la skill con el nombre tal. Y para el worker me gustaria tambien se agregara eso usando el metodo que hacemos para el explorer, lo de que se inyecta antes del primer paso."
- S4. "adaptalo pero muestrame por aqui primero que es lo que tendra la skill, despues evalua si el formato es correcto de la skill"
- S5. "aprobado tu propuesta de skill, y esta se agregara en las skills de .pi que creo es el lugar correcto. Tu propuesta sobre empaquetarla me parece bien"

## Tasks

- [x] T1 | S1 S4 S5 | inline | commit: 4fa4649 | Packaged approved `codegraph-workflow`: RED observed, unit GREEN, npm pack dry-run includes skill, isolated Pi RPC `get_commands` discovers it.
- [x] T2 | S2 S3 S5 | inline | commit: 4fa4649 | Pi owns collision handling; first-session and worker reminders are injected only for the packaged skill. Independent checks and a completed real worker with a fake provider passed (L11–L12).
- [x] T3 | S1 S2 S3 S4 S5 | inline | commit: 4fa4649 | Verified package discovery, Pi session behavior, collision, real worker and suite; updated README. Reload, fork and compaction remain unverified (L11–L12).

## Log

- L1. User, verbatim: "[local image path removed]

Vamos a crear una skill para codegraph con el contenido de la imagen pero habra que evaluar si el contenido tiene sentido y es viable.

La skill se crea cuando se instala la extension. Si existe ya una skill con el mismo nombre, se avisa al instalar.

Despues, en el primer prompt de la sesion, se inyecta que se debe usar la skill con el nombre tal. Y para el worker me gustaria tambien se agregara eso usando el metodo que hacemos para el explorer, lo de que se inyecta antes del primer paso."
- L2. User, verbatim: "adaptalo pero muestrame por aqui primero que es lo que tendra la skill, despues evalua si el formato es correcto de la skill

y si....era importante el commit de antes antes de empezar eso asi que el commit es prioritario"
- L3. User, verbatim: "aprobado tu propuesta de skill, y esta se agregara en las skills de .pi que creo es el lugar correcto. Tu propuesta sobre empaquetarla me parece bien"
- L4. T1: package test failed RED because npm files excluded the skill, then passed GREEN; npm pack --dry-run included `skills/codegraph-workflow/SKILL.md`; isolated Pi RPC get_commands reported `skill:codegraph-workflow`. No npm publication.
- L5. Isolated local `pi install <package-directory>` with an existing same-name user skill printed only installation messages, without a collision warning. On the next isolated RPC startup Pi selected the existing skill; the original file was not overwritten. No native warning was observed in that RPC check. Pi documentation describes collision diagnostics when skills are loaded, not during `pi install`. No worker or parent reminder implemented at that point.
- L6. User, verbatim: "si pi ya lo gestiona entonces no agregamos nada....

ahora lo siguiente, ¿crees adecuado que si el AGENTS.md de quien instala entra en contradiccion con la extension avisarlo?" The user chose Pi's native collision handling without an additional collision warning; do not add AGENTS.md conflict detection as part of this question.
- L7. T2 partial: added a worker routing marker, first-prompt reminder and 23 passing focused tests. The isolated Pi/fake-provider check job-19 received two parent prompts and captured the reminder once, but Pi then exited 3221226505 with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`; the worker, other-child and collision scenarios did not run. A separate `node .../dist/cli.js --version` check timed out at 20 s. No final suite, no claim of completion.
- L8. Owner, verbatim: "si, investiga". pi #9507 reports the identical RPC shutdown assertion on Node 24.19.0 and was auto-closed; nodejs/node #61999 is merged and listed in Node 24.20.0. Host: Node 24.19.0, libuv 1.52.1, Pi 1.5.0. Isolated control: one prompt then close on agent_settled passed 4/4 without and 4/4 with the extension; two prompts then close at agent_end produced the identical assertion 4/4 without and 4/4 with it. The extension is not necessary for this reproduction; the precise internal cause remains unproven. A first attempt at the two-turn control had a script syntax error, corrected before the observed control. After changing the skill check to close on agent_settled, job-23 still failed with the same assertion after the parent case; worker and collision scenarios remain unverified. No automatic runtime update or further retries.
- L9. Owner, verbatim: "tenemos nvm aqui...¿eso te sirve?" and "si" to installing Node 24.20.0 through NVM without changing the active version. Installation succeeded; PATH-isolated shell child reported Node 24.20.0 while active version remained 24.19.0. The two-prompt early-close control passed 4/4 without and 4/4 with the extension on 24.20.0, versus 4/4 assertion failures in both groups on 24.19.0. Small sample supports the upstream hypothesis but does not prove internal cause.
- L10. Node 24.20 isolated skill integration job-26 captured parent and simulated-worker reminders and no reminder in an unrelated child; collision assertion failed because CLI `-e` selected the package skill, confirmed by its path in the request. Earlier local-install RPC test used `-ne` and therefore did not prove installed-package collision precedence. Job-27 loaded the installed package without `-ne`: Pi selected the user's existing skill; job-28 captured no reminder in this collision, and showed one persistent reminder across two parent and simulated-worker requests, and none for an unrelated child.
- L11. Full suite job-29 passed 169/169 on active Node 24.19.0. Independent verifier: packaged skill loader had zero diagnostics, parent injection once across two prompts, no repeat on resume, new session injected again, collision selected existing skill with unchanged hash, explorer-like and review-like children received no reminder, and a faithful worker launch using a normalized worker definition received it. Actual `subagent_run` accepted a worker but the child was cancelled before its first turn when the isolated parent shut down; a real completed worker reminder is unverified. Reload, fork and compaction behavior are unverified. The verifier observed 9/10 existing agent files unchanged by normalization; only the worker acquired the marker. The user subsequently requested a commit; code, skill and tests were committed in 4fa4649 as the review slice.
- L12. User, verbatim: "fallo el worker? vuelve a intentar a ver". Re-verification mw36pyxw-f-ezpp: real `subagent_run` in task mode completed a `gentle-ai-worker` child with isolated fake provider `fake/fake-1`, one turn, no real credentials. Its request and session showed the packaged skill path and `codegraph-workflow-reminder` between the task and first assistant response. Harness exited 0 with Node 24.20.0. The isolated child lacked the user's MCP and memory tools; reload, fork and compaction were not tested.
