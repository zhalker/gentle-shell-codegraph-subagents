## CodeGraph

`query` finds symbols; `explore` returns source plus call paths. Use them before broad filesystem
searches — not for exact-string or filename lookups, a known file that needs no structural investigation,
or a run that only executes commands or tests — and re-map after a compaction instead of rescanning.

Evidence is never shared between checkouts: no copied, symlinked or substituted index, and the target
belongs to this clone. From the CLI the project is an explicit argument, so a worktree needs no `cd`.
