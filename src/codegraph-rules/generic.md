## CodeGraph

One `codegraph` `query` for symbols or `explore` for source plus call paths gates the search and read
tools at the start of the task; once it has answered, they are free for the rest of it. Use either whenever
the task needs symbols, structure or call paths. Exact-string and filename lookups, a known file that
needs no structural investigation, and a run that only executes commands or tests need no call.

When the workspace has no `.codegraph` index, `operation: "init"` creates it and updates an existing one.
What it returns is navigation, not proof: confirm in the source, and read a file before editing it. Each
worktree needs its own index, and no index or evidence is carried over from another checkout.
