## CodeGraph

One `codegraph` `query` for symbols or `explore` for source plus call paths gates the search and read
tools at the start of the task; once it has answered, they are free for the rest of it. Use it to locate
what the change touches, what calls the changed symbol and what still uses it, before you run the checks.
It reads the index that already exists: a verifier runs neither `init` nor any index refresh, and creating
one is never part of verification.

Its output is navigation, never evidence. A verdict comes from the source you read and the checks you
run; a graph answer a probe contradicts is the graph that is wrong, and passing the graph is not passing
the tests.
