## CodeGraph

Run a `codegraph` `query` for symbols or `explore` for source plus call paths before any search or read
— `fd`, `find`, `rg`, `grep`, `read` or `cat` — whenever a question needs symbols, structure or call
paths. Every such question starts there: a plan, the size and scope of a change, a refactor, a fix, an
analysis, an investigation, and a new doubt the earlier answer does not settle. Once the graph has
answered a question, the search and read tools are free for it. Exact-string and filename lookups, a
known file that needs no structural investigation, and a run that only executes commands or tests need
no call. When the workspace has no index it answers nothing: fall back to `read`, `grep` and `find`.
What it returns is navigation, not proof: a verdict comes from the source and from tests.

Each worktree is its own workspace with its own index, and a query answers only for the checkout it runs
in. Work in a sibling worktree or another repository belongs to an explorer delegated there: this
workspace's answer is never carried across to it.
