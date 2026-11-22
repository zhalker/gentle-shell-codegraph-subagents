# Tool overlay adaptation for gentle-pi 4.9.0

Migrate @zhalker/gentle-shell-codegraph-subagents to the gentle-pi 4.9.0 subagent tool overlay: publish a drop-in JSON file adding `mcp__codegraph__codegraph_explore` to the six gentle-ai agents instead of rewriting agent `.md` files, keeping the legacy file-editing path as fallback for gentle-pi < 4.9.0.

## Specs

- S1 — U: «Primero, iniciar codegraph en cada arranque me ralentiza el inicio en 4 segundos ya probados en varias sesiones, ¿podria ser lazy en vez de eager?» → Resuelto por medición (owner eligió «Medir primero»): CodeGraph descartado como responsable principal (~0,5 s sincrónicos); lazy descartado. No requiere cambio de código.
- S2 — U: «la 4.9.0 que tenemos instalado ofrece una nueva arquitectura para indicar las herramientas permitidas o denegadas en los subagentes, hay que adaptarnos a ello.» Estrategia decidida: overlay + fallback legacy (op 1).
- S3 — U: «ya que hiciste tu las mediciones y codegraph no parece tener el problema de tiempo, enviale un mensaje a la otra sesion dandole tu informacion que ya tienes demostrada. Despues descartamos lo del lazy y te pones con el otro cambio que hablamos» → Mensaje enviado (id 3a57ea63…) y confirmado por la sesión RCA (correlation a7a742bc…); lazy descartado. Este task ya está hecho.

## Tasks

- T1 | S2 | src/tool-overlay.ts: modelo de overlay + escritura idempotente del drop-in en `<configHome>/agent-overlays.d/`, resolviendo configHome con la precedencia de gentle-pi (bundled prefix > GENTLE_PI_CONFIG_HOME > GENTLE_SHELL_CONFIG_HOME > ~/.pi/gentle-ai) | inline | commit W1
- T2 | S2 | Detección de soporte overlay (gentle-pi >= 4.9.0) y routing: overlay si está disponible, normalizeAgent legacy si no | inline | commit W2
- T3 | S2 | extensions/index.ts: escribir el drop-in en session_start (layout); saltar el rewrite legacy cuando el overlay está activo; mantener warnings de MCP | inline | commit W3
- T4 | S2 | Tests: writer del overlay, resolución de configHome, detección y routing (RED→GREEN) | inline | commit W4
- T5 | S2 | README y docs del paquete actualizados | inline | commit W5

## Log

- L1 — U, verbatim: «Vale, es momento de mejorar algunas cosas. Primero, iniciar codegraph en cada arranque me ralentiza el inicio en 4 segundos ya probados en varias sesiones, ¿podria ser lazy en vez de eager?

Segundo, la 4.9.0 que tenemos instalado ofrece una nueva arquitectura para indicar las herramientas permitidas o denegadas en los subagentes, hay que adaptarnos a ello.»
- L2 — Owner eligió «Medir primero» para el punto lazy (opc_measure).
- L3 — Medición demostrada: sync 0,9 s; spawn MCP→initialize 0,43 s; primer explore frío 26 ms (total 0,46 s). CodeGraph descartado.
- L4 — Owner: «ya que hiciste tu las mediciones y codegraph no parece tener el problema de tiempo, enviale un mensaje a la otra sesion dandole tu informacion que ya tienes demostrada. Despues descartamos lo del lazy y te pones con el otro cambio que hablamos»
- L5 — Mensaje enviado a la sesión RCA (3a57ea63096844e8aea5e7a789292de6); respuesta recibida (correlation a7a742bc210d4a22aad869be2e8e3983): lo incorpora como F18/E13.
- L6 — Exploración del overlay 4.9.0 completada (gentle-ai-explore, task mws1jjhk-1-ot0w): overlay en discoverAgents por cada subagent_run; drop-ins en <configHome>/agent-overlays.d/*.json; agentes embarcados ya traen la herramienta y sin marker blocks; edición de archivos rompe managed ownership.
- L7 — Owner eligió «Overlay + fallback legacy» (opc_overlay_fallback).
