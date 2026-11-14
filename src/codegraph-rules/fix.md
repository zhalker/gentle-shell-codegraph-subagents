## CodeGraph

One `codegraph` `query` for symbols or `explore` for source plus call paths gates the search and read
tools at the start of the task; once it has answered, they are free for the rest of it. Use it to find the
code behind a confirmed finding and every caller the patch will reach, so the fix stays surgical. You
still read the file before editing it: what the graph returns is where code lives, not what it says. This
locates the fix; it does not widen it.

When the workspace has no `.codegraph` index, `operation: "init"` creates it and updates an existing one.
That index is the only thing CodeGraph may write. A worktree needs its own index, and no evidence is
carried over from another checkout.
