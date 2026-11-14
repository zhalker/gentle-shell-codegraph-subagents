## CodeGraph

One `codegraph` `query` for symbols or `explore` for source plus call paths gates the search and read
tools at the start of the task; once it has answered, they are free for the rest of it. Use either to map
an area, to see what calls something before you report it, and to re-map after a compaction instead of
rescanning. Exact-string and filename lookups, a known file that needs no structural investigation, and a
run that only executes commands or tests need no call. `operation: "init"` also updates an index that
already exists, so there is no separate sync step.

Evidence is never shared between checkouts: no copied, symlinked or substituted index, and the target
belongs to this clone. From the CLI, `init` and `sync` take a positional path and `query` and `explore`
take `-p`, so a worktree needs no `cd`.
