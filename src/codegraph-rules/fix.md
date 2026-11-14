## CodeGraph

One `codegraph_explore` call gates the search and read tools at the start of the task; once it has
answered, they are free for the rest of it. It returns source plus call paths, so it answers both what a
symbol is and what calls it. Use it to find the code behind a confirmed finding and every caller the
patch will reach, so the fix stays surgical. You still read the file before editing it: what it returns
is where code lives, not what it says. This locates the fix; it does not widen it.

When the workspace has no `.codegraph` index, create it with `codegraph init` through `bash`, and
`codegraph sync` refreshes an existing one. That index is the only thing CodeGraph may write. A worktree
has its own index, and no evidence is carried over from another checkout.
