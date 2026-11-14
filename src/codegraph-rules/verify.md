## CodeGraph

One `codegraph_explore` call gates the search and read tools at the start of the task; once it has
answered, they are free for the rest of it. It returns source plus call paths, so it answers both what a
symbol is and what calls it: use it to locate what the change touches, what calls the changed symbol and
what still uses it, before you run the checks. It reads the index that already exists: a verifier neither
creates nor refreshes one, and building an index is never part of verification.

Its output is navigation, never evidence. A verdict comes from the source you read and the checks you run;
an answer a probe contradicts is the tool that is wrong, and passing the graph is not passing the tests.
