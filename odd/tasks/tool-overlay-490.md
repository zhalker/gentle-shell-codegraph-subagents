# Tool overlay adaptation for gentle-pi 4.9.0

Migrate @zhalker/gentle-shell-codegraph-subagents to the gentle-pi 4.9.0 subagent tool overlay: publish a drop-in JSON file adding `mcp__codegraph__codegraph_explore` to the six gentle-ai agents instead of rewriting agent `.md` files, keeping the legacy file-editing path as fallback for gentle-pi < 4.9.0.

## Specs

- S1 — U: «Primero, iniciar codegraph en cada arranque me ralentiza el inicio en 4 segundos ya probados en varias sesiones, ¿podria ser lazy en vez de eager?» → Resuelto por medición (owner eligió «Medir primero»): CodeGraph descartado como responsable principal (~0,5 s sincrónicos); lazy descartado. No requiere cambio de código.
- S2 — U: «la 4.9.0 que tenemos instalado ofrece una nueva arquitectura para indicar las herramientas permitidas o denegadas en los subagentes, hay que adaptarnos a ello.» Estrategia decidida: overlay + fallback legacy (op 1).
- S3 — U: «ya que hiciste tu las mediciones y codegraph no parece tener el problema de tiempo, enviale un mensaje a la otra sesion dandole tu informacion que ya tienes demostrada. Despues descartamos lo del lazy y te pones con el otro cambio que hablamos» → Mensaje enviado (id 3a57ea63…) y confirmado por la sesión RCA (correlation a7a742bc…); lazy descartado. Este task ya está hecho.

## Tasks

- T1 | S2 | src/tool-overlay.ts: modelo de overlay + escritura idempotente del drop-in | inline | hecho | commit cb57f4f; tests tool-overlay.test.ts 5/5
- T2 | S2 | Detección de soporte overlay (gentle-pi >= 4.9.0, solo releases finales) | inline | hecho | commit cb57f4f; tests tool-overlay-detect.test.ts 2/2
- T3 | S2 | extensions/index.ts: applyCodegraphWiring overlay vs legacy; applyCodegraphSubagents agentFiles:false | inline | hecho | commit cb57f4f; test apply.test.ts S2
- T4 | S2 | Tests RED→GREEN | inline | hecho | suite completa 330/330
- T5 | S2 | README (overlay + uninstall) y docs/known-limits.md (divergencia configHome, detección conservadora) | inline | hecho | commit cb57f4f

## Log

- L1 — U, verbatim: «Vale, es momento de mejorar algunas cosas. Primero, iniciar codegraph en cada arranque me ralentiza el inicio en 4 segundos ya probados en varias sesiones, ¿podria ser lazy en vez de eager?

Segundo, la 4.9.0 que tenemos instalado ofrece una nueva arquitectura para indicar las herramientas permitidas o denegadas en los subagentes, hay que adaptarnos a ello.»
- L2 — Owner eligió «Medir primero» para el punto lazy (opc_measure).
- L3 — Medición demostrada: sync 0,9 s; spawn MCP→initialize 0,43 s; primer explore frío 26 ms (total 0,46 s). CodeGraph descartado.
- L4 — Owner: «ya que hiciste tu las mediciones y codegraph no parece tener el problema de tiempo, enviale un mensaje a la otra sesion dandole tu informacion que ya tienes demostrada. Despues descartamos lo del lazy y te pones con el otro cambio que hablamos»
- L5 — Mensaje enviado a la sesión RCA (3a57ea63096844e8aea5e7a789292de6); respuesta recibida (correlation a7a742bc210d4a22aad869be2e8e3983): lo incorpora como F18/E13.
- L6 — Exploración del overlay 4.9.0 completada (gentle-ai-explore, task mws1jjhk-1-ot0w): overlay en discoverAgents por cada subagent_run; drop-ins en <configHome>/agent-overlays.d/*.json; agentes embarcados ya traen la herramienta y sin marker blocks; edición de archivos rompe managed ownership.
- L7 — Owner eligió «Overlay + fallback legacy» (opc_overlay_fallback).
- L8 — Descubierto en fuente de gentle-pi (lib/gentle-shell-bundled.ts): el bundled prefix gana incluso sobre GENTLE_PI_CONFIG_HOME; el test se corrigió contra la fuente, no el código.
- L9 — Commit cb57f4f en feat/tool-overlay-490 (334 líneas, suite 330/330). Riesgo nombrado: item 3 — una divergencia futura en la resolución de configHome dejaría la herramienta fuera del allowlist en silencio; mitigación documentada en known-limits.md y detección conservadora de versión.
- L10 — Verificación independiente gentle-ai-verify lanzada sobre el commit (routing overlay/legacy + contractos).
