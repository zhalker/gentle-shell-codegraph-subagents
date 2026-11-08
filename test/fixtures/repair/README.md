# Repair fixtures

Synthetic agent files for `test/repair.test.ts`. They are not copies of anything on a real machine and they
are never read from `~/.pi`: each test copies what it needs into a fresh temp directory.

- `shipped/*.md`: what gentle-pi ships as an agent, as far as the repair cares (name, routing, tools, body).
  `models.json` holds the routing the tests save for them.
- `derived/*.backup.md`: the same file with gentle-ai's marker block appended the way gentle-ai appends it
  (`body without its trailing newlines + "\n\n" + block`), which is the `.pre-codegraph-subagents.bak` a
  frozen user has.
- `derived/*.frozen-v0.6.0.md` and `derived/gentle-ai-worker.frozen-v0.1.0.md`: the output of the frozen
  normalizers for those backups, produced outside this repository from the published 0.6.0 and 0.1.0
  sources. The first test in `test/repair.test.ts` fails if `src/legacy-agents.ts` stops reproducing them.
