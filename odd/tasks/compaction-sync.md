# Sync on compaction
Background synchronization for long sessions, with bounded coordination between package-managed operations.
Branch: `feat/compaction-sync` from `0177c7a`.

## Specs

- S1. "un sync despues de cada compactacion"; "1. si"; "2. si": after a parent compaction, request a background sync only when an index exists, without blocking the session or initializing a project.
- S2. "3. si"; "si, me parece": prevent simultaneous extension-started syncs for the same project; coalesce compactions during a sync into at most one follow-up after it completes. Coordination applies only to cooperating local processes sharing the same temporary directory.
- S3. "4. no": do not show a failure notification for compaction sync; keep diagnostic results in a log.
- S4. "lo de los worktree, es otro tema que abordaremos una vez esto este implementado": no worktree behavior changes; children do not initiate compaction sync.
- S5. "solo una duda, pusimos un guard para el index pero...¿y si mejor es que no permita dos al mismo tiempo? es mejor?": investigate and explain separately; do not change index guard without further authorization.

## Tasks

- [x] T1 | S1-S4 | worker | Implement and test coordination and compaction sync, preserve startup behavior and document limitations. | b7fd962
- [x] T2 | S1-S4 | independent verifier | Verify concurrency, regression tests and applicable functional evidence. | b7fd962
- [x] T3 | S1-S5 | inline | Review, record evidence and report outcome; no publishing without separate authorization. | b7fd962; evidence update follows

## Log

- L1. User: "vale, suponiendo que estamos en main otra vez...hay otra cosa que se me olvido, un sync despues de cada compactacion, ¿como lo ves? ¿viable? ¿correcto? asi despues de cada x tiempo se tiene actualizado el codegraph"
- L2. User: "1. si 2. si 3. si 4. no 5. el sync pensaba se hacia al inciar un subagente, al menos en worker o explorer no? ya que es de interes lo tengan pero si te parece no adecuado me dices. Y esto tiene mayor peso en unidades de red donde el monitor automatico, el watcher no funciona"
- L3. User: "si, me parece\n\nlo de los worktree, es otro tema que abordaremos una vez esto este implementado\n\nsolo una duda, pusimos un guard para el index pero...¿y si mejor es que no permita dos al mismo tiempo? es mejor?"
- L4. Existing sync does not acquire the init lock. External CodeGraph operations and other machines do not share the package temp lock. Earlier isolated tests found sync exit 0 can mean no update while another writer holds CodeGraph's lock; prefetch can see stale or partial results. Do not claim freshness or race-free reads.
- L5. T1 writer reports RED on missing coordinator and startup coordination; GREEN focused coordinator 17/17, autoindex/initlock/prepare 75/75, index-notice 14/14. Full suite 265/265. Assess escalated item 4; native candidate unassessable until untracked selection is declared.
- L6. Independent verifier S2 partially met: deterministic B1, consumed pending request disappears before follow-up completes and runner death loses it while waiter reports coalesced. A1: killed runner can leave a CLI child alive while a second extension sync takes over and overlaps. A5: init-lock check is a TOCTOU and compaction during init is dropped. Correct candidate-caused concurrency defects in one bounded correction; no claim that exit 0 proves freshness. Live Pi compaction was not verified.
- L7. Writer correction reports targeted RED for B1, A1 and A5; GREEN coordinator tests 21/21, autoindex/initlock/prepare 84/84, index-notice 14/14. Full suite after correction 278/278. Independent targeted reverification reports B1, A1 and A5 fixed, focused suites 45/45 and 60/60. Live Pi compaction remains unverified. Coordination remains local/cooperative; external writers and other machines are outside its scope.
- L8. Implementation committed as b7fd962; single cohesive high-risk unit is 1,360 changed lines, exceeding the 400-line advisory and requiring special review attention. Native assessment: medium native, escalated to high for concurrency; reviewDue false. No PR, push or release authorized in this feature.
