const EXPLORE = "codegraph_explore";

function matchingExposure(entry: Record<string, unknown>): string | undefined {
	const tools = entry.toolExposure;
	if (!tools || typeof tools !== "object" || Array.isArray(tools)) return undefined;
	const values = tools as Record<string, unknown>;
	if (typeof values[EXPLORE] === "string") return values[EXPLORE] as string;
	for (const [pattern, exposure] of Object.entries(values)) {
		if (!pattern.includes("*") || typeof exposure !== "string") continue;
		const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		if (regex.test(EXPLORE)) return exposure;
	}
	return undefined;
}

function codegraphServer(text: string): Record<string, unknown> | undefined {
	try {
		const config = JSON.parse(text);
		const entry = config?.mcpServers?.codegraph;
		return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : undefined;
	} catch { return undefined; }
}

/** Missing is distinct from disabled, invalid configuration and servers registered by extensions. */
export function isCodegraphServerMissing(globalText: string, projectText?: string, registered = false): boolean {
	if (registered) return false;
	const read = (text: string): Record<string, unknown> | undefined => {
		try {
			const value = JSON.parse(text);
			return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
		} catch { return undefined; }
	};
	const global = read(globalText);
	const project = projectText === undefined ? undefined : read(projectText);
	if (!global || (projectText !== undefined && !project)) return false;
	const hasServer = (config: Record<string, unknown>): boolean => {
		const servers = config.mcpServers;
		return !!servers && typeof servers === "object" && !Array.isArray(servers)
			&& Object.prototype.hasOwnProperty.call(servers, "codegraph");
	};
	if (hasServer(global)) return false;
	if (!project || !hasServer(project)) return true;
	const servers = project.mcpServers as Record<string, unknown>;
	const entry = servers.codegraph;
	// A project-only override cannot create a server without a transport definition.
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		return !("command" in entry || "url" in entry || "type" in entry);
	}
	return false; // Let Pi report an invalid server entry instead of claiming it is absent.
}

/** Explicit restrictions must be respected, not overridden silently. */
export function inspectMcpExposure(text: string): string | undefined {
	const entry = codegraphServer(text);
	if (!entry) return undefined;
	if (entry.enabled === false) return "disabled";
	const selected = matchingExposure(entry);
	if (entry.exposure === "hidden" && selected === "direct") return "hidden-with-direct";
	if (selected !== undefined) return selected === "direct" ? undefined : selected;
	const exposure = typeof entry.exposure === "string" ? entry.exposure : "codemode";
	return exposure === "direct" ? undefined : exposure;
}

/** Inspect the effective file configuration, including a trusted project's override when supplied. */
export function inspectEffectiveMcpExposure(globalText: string, projectText?: string): string | undefined {
	const global = codegraphServer(globalText);
	const project = projectText === undefined ? undefined : codegraphServer(projectText);
	if (!project) return inspectMcpExposure(globalText);
	const replacement = "command" in project || "url" in project || "type" in project;
	const entry = replacement ? project : { ...global, ...project };
	return inspectMcpExposure(JSON.stringify({ mcpServers: { codegraph: entry } }));
}

/** Select direct access for explore without changing the server-wide exposure. */
export function normalizeMcpConfig(text: string): string {
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		return text;
	}
	if (typeof config !== "object" || config === null || Array.isArray(config)) return text;
	const servers = (config as { mcpServers?: unknown }).mcpServers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return text;
	const server = (servers as Record<string, unknown>).codegraph;
	if (typeof server !== "object" || server === null || Array.isArray(server)) return text;
	const entry = server as Record<string, unknown>;
	if (entry.enabled === false || matchingExposure(entry) !== undefined || entry.exposure === "hidden") return text;
	if (entry.toolExposure !== undefined && (typeof entry.toolExposure !== "object" || entry.toolExposure === null || Array.isArray(entry.toolExposure))) return text;
	entry.toolExposure = { ...(entry.toolExposure as Record<string, unknown> | undefined), [EXPLORE]: "direct" };
	const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
	return JSON.stringify(config, null, indent) + "\n";
}
