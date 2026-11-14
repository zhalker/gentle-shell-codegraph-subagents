## CodeGraph

One `codegraph` `query` for symbols or `explore` for source plus call paths gates the search and read
tools at the start of the task; once it has answered, they are free for the rest of it. Use it to see what
the reviewed change touches, what calls it and what it calls, so the sweep reaches the real blast radius.
It reads the index that already exists: a judge runs neither `init` nor any index refresh.

Its output is navigation, never proof. Confirm every finding in the source before reporting it, and report
only what the source shows; a graph answer alone is not a finding, and navigating the graph is not fixing.
