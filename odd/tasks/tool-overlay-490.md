# Tool overlay adaptation for gentle-pi 4.9.0

Migrate @zhalker/gentle-shell-codegraph-subagents to the gentle-pi 4.9.0 subagent tool overlay: publish a drop-in JSON file adding `mcp__codegraph__codegraph_explore` to the six gentle-ai agents instead of rewriting agent `.md` files, keeping the legacy file-editing path as fallback for gentle-pi < 4.9.0.

## Specs

- S1 — U: «Primero, iniciar codegraph en cada arranque me ralentiza el inicio en 4 segundos ya probados en varias sesiones, ¿podria ser lazy en vez de eager?» → Resuelto por medición (owner eligió «Medir primero»): CodeGraph descartado como responsable principal (~0,5 s sincrónicos); lazy descartado. No requiere cambio de código.
- S2 — U: «la 4.9.0 que tenemos instalado ofrece una nueva arquitectura para indicar las herramientas permitidas o denegadas en los subagentes, hay que adaptarnos a ello.» Estrategia decidida: overlay + fallback legacy (op 1).
- S3 — U: «ya que hiciste tu las mediciones y codegraph no parece tener el problema de tiempo, enviale un mensaje a la otra sesion dandole tu informacion que ya tienes demostrada. Despues descartamos lo del lazy y te pones con el otro cambio que hablamos» → Mensaje enviado (id 3a57ea63…) y confirmado por la sesión RCA (correlation a7a742bc…); lazy descartado. Este task ya está hecho.

## Tasks

- T-P5 | S2 (extensión: codegraph 1.6.4) | Marker de versión del índice (.codegraph/indexer-version.json) + reindex coordinado en background cuando el engine cambió | worker | hecho | commit 8ed6d50; suite completa 344/344 observada por el padre; tests P5: reindex.test.ts 5/5 + 7 de integración en prepare.test.ts

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
- L10 — Verificación independiente gentle-ai-verify (task mws246vn-2-oejb): suite 330/330 observada; contrato del drop-in contra fuente gentle-pi correcto; detectó 1 divergencia real (GENTLE_PI_CONFIG_HOME relativo: gentle-pi lo honorifica verbatim, nosotros exigíamos absoluto → drop-in donde gentle-pi no lee) + 2 gaps de aserción (stashed sin comparar, stale copy sin crear) y 1 caso faltante (PI vs SHELL juntos).
- L11 — Corrección test-first (RED→GREEN): absoluteness gate solo para GENTLE_SHELL_CONFIG_HOME, PI_CONFIG_HOME verbatim + caso PI vs SHELL juntos; gaps de aserción cubiertos. Commit b910a96, suite 330/330. Cierre de la feature.
- L12 — Owner autorizó upgrade de codegraph 1.6.0→1.6.4 y el plan P1-P5. Hechos: P1 upgrade (refrescó mcp.json y AGENTS.md de Pi; toolExposure directo preservado), P2 suite (S16 flake pre-existente bajo carga paralela, no regresión: pasa aislado y hubo corrida completa 330/330), P3 handshake daemon intacto (hello line + registry compatibles; ok=true en 1.6.4), P4 compose bien con codegraph install. P5 en curso: índice quedó "predates the running engine" hasta re-index; diseño: marker por proyecto escrito por init/seed/reindex del paquete, reindex coordinado por init lock en background, `unknown` sin marker no fuerza nada.
- L13 — El worker encontró 2 defectos reales de mis tests RED: warm callback ignoraba cwd, y `codegraph index -y` no existe en 1.6.4 (solo -f/-q/-v/-h; runCodegraph ya agrega la ruta). Decisión A: warm:${cwd} + run ["index","-q"].
- L14 — Worker entregó T-P5: reindex coordinado por init lock, marker escrito solo tras init/seed/reindex propio con éxito, `codegraph --version` sondeada async una vez por proceso (skip en reload/hijos). Suite completa del padre: 344/344. Commit 8ed6d50. Slice de 3 commits = 679 líneas: al publicar, elegir forma de entrega (chained PR candidate).
- L15 — Codegraph 1.6.4 verificado en vivo: index re-construido a mano (codegraph index, 3,2 s), status "up to date", daemon responde ok=true. Los demás proyectos del owner quedan con índice viejo: el reindex automático nuevo los cubre en su próxima sesión.
- L16 — README actualizado (524212f): rebuild post-upgrade en la sección del índice + nota de composición con el soporte Pi oficial de codegraph 1.6.3+ (mcp.json/AGENTS.md de upstream; lo del subagent allowlist, prefetch, coordinación y rebuild sigue siendo solo de este paquete).
- L17 — Owner preguntó por "llamar al MCP en before_agent_start": confirmado que es posible sin truco (función = cliente MCP del server; warmup.ts ya lo hace). Pendiente candidato: fallback del prefetch vía exploreOnce() cuando el registry/hello del daemon cambie (camino lento pero contracto estable). Sin prisa; anotado.
