/**
 * MCP server inventory across every scope Claude Code resolves servers from:
 * user (~/.claude.json top-level), local (~/.claude.json projects[root]),
 * project (<root>/.mcp.json) and plugin (each installed plugin's own
 * .mcp.json / plugin.json).
 *
 * SECURITY: every `env` and `headers` value is masked via lib/mask.mjs before
 * it enters the returned structure. `envKeys` carries key NAMES only — those
 * are safe to display in full and are how the panel shows "this server wants
 * ANTHROPIC_API_KEY" without ever showing the key's value.
 *
 * READ ONLY: only readJsonFile (fs.readFileSync/lstatSync, via source-file.mjs)
 * is used, plus the same primitive inside plugins-scan.mjs for plugin
 * discovery. No write call exists here, and no MCP server is ever spawned —
 * this module only reads the config that WOULD spawn one.
 */
import path from 'node:path';
import { readJsonFile, vscodeLink } from './source-file.mjs';
import { lineOf } from './json-locate.mjs';
import { maskEnv } from './mask.mjs';
import { resolveLayerPaths, SETTINGS_CASCADE } from './layers.mjs';
import { scanPlugins } from './plugins-scan.mjs';

/** Every character outside [a-zA-Z0-9_-] becomes '_' — the form tool names use. */
function normalizeMcpName(name) {
	if (typeof name !== 'string') return '';
	return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function detectTransport(config) {
	if (config.type === 'stdio' || (config.command && !config.type)) return 'stdio';
	if (config.type === 'sse') return 'sse';
	if (config.type === 'http') return 'http';
	if (config.url) return 'http';
	return config.command ? 'stdio' : 'unknown';
}

/** Builds a server record from a raw config object plus the location it came from. */
function buildServerRecord({ name, config, scope, sourcePath, line, lineIndexUnused }) {
	const transport = detectTransport(config ?? {});
	const rawEnv = config?.env && typeof config.env === 'object' ? config.env : null;
	const rawHeaders = config?.headers && typeof config.headers === 'object' ? config.headers : null;
	return {
		name,
		normalizedName: normalizeMcpName(name),
		scope,
		transport,
		command: config?.command ?? null,
		args: Array.isArray(config?.args) ? config.args : [],
		url: config?.url ?? null,
		envKeys: rawEnv ? Object.keys(rawEnv) : [],
		env: rawEnv ? maskEnv(rawEnv) : {},
		headers: rawHeaders ? maskEnv(rawHeaders) : {},
		sourcePath,
		line,
		link: vscodeLink(sourcePath, line),
		disabled: false,
		disabledSource: null,
		needsAuth: null,
		authCacheMtime: null,
		error: null,
	};
}

/** Reads the needs-auth cache once and returns a lookup usable for every server. */
function loadAuthCache({ home }) {
	const cachePath = path.join(home, '.claude', 'mcp-needs-auth-cache.json');
	const file = readJsonFile(cachePath);
	if (!file.exists || !file.json) return { entries: null, mtimeMs: null };
	return { entries: file.json, mtimeMs: file.mtimeMs };
}

/**
 * Best-effort cache key match: the one observed real-world key shape is
 * `plugin:<marketplace>:<pluginName>`; plain server names are tried for
 * non-plugin scopes. No match is a genuinely unknown state (null), never a
 * fabricated `false` — the panel makes no network calls and cannot know
 * current connectivity, only what this CACHE last recorded.
 */
function lookupNeedsAuth(authCache, { scope, name, normalizedName, marketplace, pluginName }) {
	if (!authCache.entries) return { needsAuth: null, authCacheMtime: null };
	const candidates = [name, normalizedName];
	if (scope === 'plugin' && marketplace && pluginName) {
		candidates.push(`plugin:${marketplace}:${pluginName}`, `plugin:${marketplace}:${name}`);
	}
	const hit = candidates.some((key) => Object.hasOwn(authCache.entries, key));
	return { needsAuth: hit ? true : null, authCacheMtime: hit ? authCache.mtimeMs : null };
}

/** Resolves the cascade-level disabled/enabled sets for .mcp.json (project-scope) servers. */
function resolveMcpJsonCascade({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });
	const layerPathById = {
		user: paths.user.settings,
		project: paths.project.settings,
		local: paths.local.settings,
		enterprise: paths.enterprise.managedSettings,
	};
	let disabled = new Map(); // name -> {sourcePath, line, link}
	let enabled = new Map();
	for (const layerId of SETTINGS_CASCADE) {
		const filePath = layerPathById[layerId];
		const file = readJsonFile(filePath);
		if (!file.json) continue;
		if (Array.isArray(file.json.disabledMcpjsonServers)) {
			file.json.disabledMcpjsonServers.forEach((serverName, idx) => {
				const line = lineOf(file.lineIndex, `disabledMcpjsonServers[${idx}]`);
				disabled.set(serverName, { path: filePath, line, link: vscodeLink(filePath, line) });
			});
		}
		if (Array.isArray(file.json.enabledMcpjsonServers)) {
			file.json.enabledMcpjsonServers.forEach((serverName, idx) => {
				const line = lineOf(file.lineIndex, `enabledMcpjsonServers[${idx}]`);
				enabled.set(serverName, { path: filePath, line, link: vscodeLink(filePath, line) });
			});
		}
	}
	return { disabled, enabled };
}

/**
 * @param {{home: string, projectRoot: string}} options
 */
export function scanMcpServers({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });
	const authCache = loadAuthCache({ home });
	const servers = [];

	// --- user + local scope: both live inside ~/.claude.json ---
	const globalConfigPath = paths.user.globalConfig;
	const globalFile = readJsonFile(globalConfigPath);
	const sources = {
		user: {
			path: globalConfigPath,
			exists: globalFile.exists,
			readable: globalFile.readable,
			error: globalFile.error || globalFile.parseError || null,
		},
	};

	const projectEntry = globalFile.json?.projects?.[projectRoot] ?? null;
	const disabledMcpServers = Array.isArray(projectEntry?.disabledMcpServers) ? projectEntry.disabledMcpServers : [];

	function disabledMcpServerSource(name) {
		if (!disabledMcpServers.includes(name)) return null;
		const idx = disabledMcpServers.indexOf(name);
		const jsonPath = `projects.${projectRoot}.disabledMcpServers[${idx}]`;
		const line = lineOf(globalFile.lineIndex, jsonPath);
		return { path: globalConfigPath, line, link: vscodeLink(globalConfigPath, line) };
	}

	if (globalFile.json?.mcpServers && typeof globalFile.json.mcpServers === 'object') {
		for (const [name, config] of Object.entries(globalFile.json.mcpServers)) {
			const jsonPath = `mcpServers.${name}`;
			const line = lineOf(globalFile.lineIndex, jsonPath);
			const record = buildServerRecord({ name, config, scope: 'user', sourcePath: globalConfigPath, line });
			const disabledSource = disabledMcpServerSource(name);
			record.disabled = disabledSource !== null;
			record.disabledSource = disabledSource;
			const auth = lookupNeedsAuth(authCache, { scope: 'user', name, normalizedName: record.normalizedName });
			record.needsAuth = auth.needsAuth;
			record.authCacheMtime = auth.authCacheMtime;
			servers.push(record);
		}
	}

	if (projectEntry?.mcpServers && typeof projectEntry.mcpServers === 'object') {
		for (const [name, config] of Object.entries(projectEntry.mcpServers)) {
			const jsonPath = `projects.${projectRoot}.mcpServers.${name}`;
			const line = lineOf(globalFile.lineIndex, jsonPath);
			const record = buildServerRecord({ name, config, scope: 'local', sourcePath: globalConfigPath, line });
			const disabledSource = disabledMcpServerSource(name);
			record.disabled = disabledSource !== null;
			record.disabledSource = disabledSource;
			const auth = lookupNeedsAuth(authCache, { scope: 'local', name, normalizedName: record.normalizedName });
			record.needsAuth = auth.needsAuth;
			record.authCacheMtime = auth.authCacheMtime;
			servers.push(record);
		}
	}

	// --- project scope: <projectRoot>/.mcp.json, absent by default ---
	const mcpJsonPath = paths.project.mcpJson;
	const mcpJsonFile = readJsonFile(mcpJsonPath);
	sources.project = {
		path: mcpJsonPath,
		exists: mcpJsonFile.exists,
		readable: mcpJsonFile.readable,
		error: mcpJsonFile.error || mcpJsonFile.parseError || null,
	};
	if (mcpJsonFile.json?.mcpServers && typeof mcpJsonFile.json.mcpServers === 'object') {
		const { disabled: mcpJsonDisabled } = resolveMcpJsonCascade({ home, projectRoot });
		for (const [name, config] of Object.entries(mcpJsonFile.json.mcpServers)) {
			const jsonPath = `mcpServers.${name}`;
			const line = lineOf(mcpJsonFile.lineIndex, jsonPath);
			const record = buildServerRecord({ name, config, scope: 'project', sourcePath: mcpJsonPath, line });
			const disabledEntry = mcpJsonDisabled.get(name) ?? null;
			record.disabled = disabledEntry !== null;
			record.disabledSource = disabledEntry;
			const auth = lookupNeedsAuth(authCache, { scope: 'project', name, normalizedName: record.normalizedName });
			record.needsAuth = auth.needsAuth;
			record.authCacheMtime = auth.authCacheMtime;
			servers.push(record);
		}
	}

	// --- plugin scope: every installed plugin's own .mcp.json ---
	// Delegates plugin discovery + active-version selection + enabled-cascade
	// resolution to plugins-scan.mjs, the single source of truth for "which
	// version of this plugin is live" — re-deriving that here would risk
	// drifting from it (and did: an earlier version of this function walked
	// every cached version and duplicated servers from orphaned old versions).
	const pluginScan = scanPlugins({ home, projectRoot });
	sources.pluginCacheDir = pluginScan.sources.cacheDir;

	for (const plugin of pluginScan.plugins) {
		const mcpJsonPluginPath = path.join(plugin.path, '.mcp.json');
		const pluginMcpFile = readJsonFile(mcpJsonPluginPath);
		if (!pluginMcpFile.exists || !pluginMcpFile.json) continue;
		const map =
			pluginMcpFile.json.mcpServers && typeof pluginMcpFile.json.mcpServers === 'object'
				? pluginMcpFile.json.mcpServers
				: pluginMcpFile.json;
		if (!map || typeof map !== 'object') continue;
		const wrapped = Object.hasOwn(pluginMcpFile.json, 'mcpServers');

		for (const [serverName, config] of Object.entries(map)) {
			const jsonPath = wrapped ? `mcpServers.${serverName}` : serverName;
			const line = lineOf(pluginMcpFile.lineIndex, jsonPath);
			const record = buildServerRecord({
				name: serverName,
				config,
				scope: 'plugin',
				sourcePath: mcpJsonPluginPath,
				line,
			});
			record.normalizedName = `plugin_${normalizeMcpName(plugin.name)}_${normalizeMcpName(serverName)}`;
			record.disabled = !plugin.enabled;
			record.disabledSource = plugin.enabled
				? null
				: plugin.enabledSource && { path: plugin.enabledSource, line: plugin.enabledLine, link: plugin.enabledLink };
			const auth = lookupNeedsAuth(authCache, {
				scope: 'plugin',
				name: serverName,
				normalizedName: record.normalizedName,
				marketplace: plugin.marketplace,
				pluginName: plugin.name,
			});
			record.needsAuth = auth.needsAuth;
			record.authCacheMtime = auth.authCacheMtime;
			servers.push(record);
		}
	}

	return { servers, sources };
}
