import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * How a directory relates to a git repository. A linked worktree carries its own `.codegraph` decision: it
 * indexes its own tree, never the main checkout's.
 */
export type WorktreeInfo = { worktree: false } | { worktree: true; /** The shared repository root every worktree of this clone hangs from. */ commonRoot: string };

/**
 * Detects whether `cwd` is a linked git worktree: there, `.git` is a file with `gitdir: <path>` pointing into
 * the main repository's `.git/worktrees/<name>`. The common root is that main repository, found from the
 * gitdir by walking up to the directory whose `.git` is a directory (the worktree's gitdir lives inside it).
 * A plain repo (.git as a directory), a `.git` file that is not a worktree pointer, or anything unreadable is
 * not a worktree: the caller falls back to the normal per-directory decision.
 */
export function worktreeOf(cwd: string): WorktreeInfo {
	try {
		const dotGit = join(cwd, ".git");
		if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return { worktree: false };
		const first = readFileSync(dotGit, "utf8").split(/\r?\n/, 1)[0] ?? "";
		const match = /^gitdir:\s*(.+)$/i.exec(first.trim());
		if (!match) return { worktree: false };
		const gitdir = resolve(cwd, match[1].trim());
		if (!existsSync(gitdir)) return { worktree: false };
		// The worktree gitdir is <commonRoot>/.git/worktrees/<name>; walk up to the .git directory itself.
		let dir = dirname(gitdir);
		while (true) {
			const candidate = join(dir, ".git");
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return { worktree: true, commonRoot: dir };
			const parent = dirname(dir);
			if (parent === dir) return { worktree: false };
			dir = parent;
		}
	} catch {
		return { worktree: false };
	}
}
