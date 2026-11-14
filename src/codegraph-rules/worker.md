## CodeGraph

One `mcp__codegraph__codegraph_explore` call gates the search and read tools at the start of the task;
once it has answered, they are free for the rest of it. It returns source plus call paths, so it answers
both what a symbol is and what calls it. Use it to find the code you are about to change and everything
that calls it, before a refactor and again after it to confirm nothing else used what you moved. You still
read the file before editing it: what it returns is where code lives, not what it says. Exact-string and
filename lookups need no call.

When the workspace has no index it answers nothing: fall back to `read`, `grep` and `find`. A worktree
has its own index, and no evidence is carried over from another checkout.
