## CodeGraph

One CodeGraph call gates the search and read tools at the start of the task; once it has answered, they
are free for the rest of it. Use `query` for symbols or `explore` for source plus call paths when you
hold the native `codegraph` tool, and `mcp__codegraph__codegraph_explore` for both when you hold only
the MCP one. Exact-string and filename lookups, a known file that needs no structural investigation, and a
run that only executes commands or tests need no call. When the workspace has no index it answers nothing:
fall back to `read`, `grep` and `find`.

What it returns is navigation, not proof: confirm in the source, and read a file before editing it. Each
worktree has its own index, and no index or evidence is carried over from another checkout.
