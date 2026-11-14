## CodeGraph

One `codegraph_explore` call gates the search and read tools at the start of the task; once it has
answered, they are free for the rest of it. It returns source plus call paths, so it answers both what a
symbol is and what calls it: use it to see what the reviewed change touches, what calls it and what it
calls, so the sweep reaches the real blast radius. It reads the index that already exists: a judge neither
creates nor refreshes one.

Its output is navigation, never proof. Confirm every finding in the source before reporting it, and report
only what the source shows; an answer alone is not a finding, and navigating the graph is not fixing.
