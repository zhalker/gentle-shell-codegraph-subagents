import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// One root identity and one way to start codegraph.
//
// Windows spells a network folder two ways, the mapped drive (Y:\...) and the UNC path behind it
// (\\server\share\...). Pi subagent children run with the UNC cwd while the main session, and the daemon it
// registers, use the drive letter. And cmd.exe, which Windows needs for the npm .cmd shim, does not accept a
// UNC working directory: it runs the command in the Windows directory instead. So roots are compared in one
// canonical form, and codegraph always runs from the temp dir with the project passed as an argument.
//
// The project path never goes into the command line itself: cmd.exe would expand %VAR% in it even inside
// quotes. It travels in PROJECT_ENV, and the command line only names that variable; cmd.exe and sh expand a
// variable once, so its value reaches codegraph literally.
//
// Linux and macOS: realpathSync.native is realpath(3) and the JS realpathSync "behaves like realpath(3)"
// except for case conversion (Node fs docs), so the canonical form does not change there. There are no drive
// letters or UNC paths. Case is folded only on win32. With musl libc, native realpath needs /proc; when it
// fails the plain realpath, then resolve, take over.

/** Lower case and no trailing separator on Windows; only the trailing separator elsewhere. Roots stay roots. */
export function foldRoot(path: string, platform: NodeJS.Platform = process.platform): string {
	let out = path;
	while (out.length > 1 && (out.endsWith("\\") || out.endsWith("/")) && !/^[A-Za-z]:[\\/]$/.test(out)) out = out.slice(0, -1);
	return platform === "win32" ? out.toLowerCase() : out;
}

/** The identity of a project root: symlinks resolved, and on Windows the mapped drive turned into its UNC path. */
export function canonicalRoot(path: string, platform: NodeJS.Platform = process.platform): string {
	let real: string;
	try { real = realpathSync.native(path); } catch {
		try { real = realpathSync(path); } catch { real = resolve(path); }
	}
	return foldRoot(real, platform);
}

/** The environment variable that carries the project path to a shell command line. */
export const PROJECT_ENV = "CODEGRAPH_SUBAGENTS_PROJECT";

/** A shell command line plus the variables it needs on top of the inherited environment. */
export interface ShellCommand {
	command: string;
	env: Record<string, string>;
}

/** The project as one quoted shell argument that the platform shell takes from PROJECT_ENV. */
function projectArg(project: string, platform: NodeJS.Platform): ShellCommand {
	if (platform === "win32") {
		// A trailing backslash would escape the closing quote: C:\ is passed as C:\. (the same directory).
		return { command: `"%${PROJECT_ENV}%"`, env: { [PROJECT_ENV]: project.endsWith("\\") ? `${project}.` : project } };
	}
	return { command: `"$${PROJECT_ENV}"`, env: { [PROJECT_ENV]: project } };
}

export interface CodegraphSpawn {
	command: string;
	args: string[];
	cwd: string;
	shell: boolean;
	env: Record<string, string>;
}

/** `codegraph <args> <project>` from the temp dir: through cmd.exe on Windows (the .cmd shim), without a shell elsewhere. */
export function codegraphSpawn(args: string[], project: string, platform: NodeJS.Platform = process.platform): CodegraphSpawn {
	if (platform === "win32") {
		const arg = projectArg(project, platform);
		return { command: ["codegraph", ...args, arg.command].join(" "), args: [], cwd: tmpdir(), shell: true, env: arg.env };
	}
	return { command: "codegraph", args: [...args, project], cwd: tmpdir(), shell: false, env: {} };
}

/** The warm-up server command with the project named by -p, since it no longer runs in the project directory. */
export function serveCommand(command: string, project: string, platform: NodeJS.Platform = process.platform): ShellCommand {
	const arg = projectArg(project, platform);
	return { command: `${command} -p ${arg.command}`, env: arg.env };
}
