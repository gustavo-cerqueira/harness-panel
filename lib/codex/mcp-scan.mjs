/**
 * Codex counterpart of `../mcp-scan.mjs`: MCP server inventory across every
 * scope Codex resolves servers from.
 *
 * Four sources, four scopes:
 *   - 'user'    -- `[mcp_servers.*]` in `<codexHome>/config.toml`.
 *   - 'project' -- `[mcp_servers.*]` in `<projectRoot>/.codex/config.toml`.
 *   - 'profile' -- `[mcp_servers.*]` in any `<codexHome>/*.config.toml`
 *     (`--profile <name>` file). These are an OVERLAY, only active when that
 *     profile is selected at launch -- this panel has no way to know which
 *     profile (if any) a future run will pick, so every row from a profile
 *     file is flagged `ignored: true` rather than silently merged into the
 *     active inventory. `full_access.config.toml` is a real example: it
 *     holds only `[mcp_servers.playwright.tools.<tool>].approval_mode`
 *     overrides for a server actually DEFINED in `config.toml`, not a
 *     redefinition -- its row still carries `command`/`url: null` and only
 *     `toolApprovalModes` populated, which is the honest shape for "this
 *     file changes approval behavior for a server it does not itself define".
 *   - 'plugin'  -- servers contributed by an installed plugin, discovered
 *     via `scanCodexPlugins()` (`./plugins-scan.mjs` is the single source of
 *     truth for "which cached version is active" and "is this plugin
 *     enabled", exactly as `../mcp-scan.mjs` delegates to `../plugins-scan.mjs`
 *     for the same reason: re-deriving plugin state here risks drifting from
 *     it). A plugin-contributed server's row `name` is `<plugin>:<server>`
 *     for display, but `normalizedName` is derived from the bare server id
 *     only (`mcp__<id>`) -- Codex's runtime tool-call namespace
 *     (`function_call.namespace`) is NOT plugin-prefixed, so matching a
 *     rollout's `mcp__basic_memory` calls back to inventory requires the bare
 *     form, not a display-friendly compound one. `[plugins.<id>.mcp_servers.
 *     <server>]` overrides in `config.toml` (enablement, per-tool approval)
 *     are applied on top of the plugin-contributed row after it is built.
 *
 * SECURITY: `envKeys` never carries values -- only declared key NAMES, from
 * `env` (a literal map), `env_vars` (a bare name array whose values come from
 * the parent process's environment, never stored in config), and
 * `env_http_headers` / `http_headers`. No masked-value object is emitted at
 * all for MCP rows (stricter than the Claude module, which still emits a
 * masked `env`/`headers` object) -- names are the only thing this panel needs
 * to show "this server wants ANTHROPIC_API_KEY" without ever holding the
 * value in memory once masking would apply.
 *
 * READ ONLY: fs.readdirSync plus the shared readSourceFile / readJsonFile
 * primitives. No MCP server is ever spawned -- this module only reads the
 * config that WOULD spawn one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, readJsonFile, vscodeLink } from '../source-file.mjs';
import { lineOf } from '../json-locate.mjs';
import { parseToml, lineOfTomlKey } from './toml.mjs';
import { resolveCodexPaths } from './layers.mjs';
import { scanCodexPlugins } from './plugins-scan.mjs';

/** Codex's runtime MCP tool-call namespace form: 'mcp__' + name, '-' -> '_'. */
function normalizeMcpName(name) {
	if (typeof name !== 'string') return '';
	return `mcp__${name.replace(/-/g, '_')}`;
}

function numOrNull(v) {
	return typeof v === 'number' ? v : null;
}
function strOrNull(v) {
	return typeof v === 'string' ? v : null;
}
function boolOrNull(v) {
	return typeof v === 'boolean' ? v : null;
}
function arrOrEmpty(v) {
	return Array.isArray(v) ? v : [];
}

function buildCommand(config) {
	if (typeof config?.command !== 'string') return null;
	const args = Array.isArray(config.args) ? config.args : [];
	return [config.command, ...args].join(' ');
}

/** Every declared env-supplying key name across the shapes Codex uses -- values never included. */
function collectEnvKeys(config) {
	const keys = new Set();
	if (config?.env && typeof config.env === 'object') for (const k of Object.keys(config.env)) keys.add(k);
	if (Array.isArray(config?.env_vars)) for (const k of config.env_vars) if (typeof k === 'string') keys.add(k);
	if (config?.env_http_headers && typeof config.env_http_headers === 'object') {
		for (const k of Object.keys(config.env_http_headers)) keys.add(k);
	}
	if (config?.http_headers && typeof config.http_headers === 'object') {
		for (const k of Object.keys(config.http_headers)) keys.add(k);
	}
	return [...keys];
}

function collectToolApprovalModes(config) {
	const out = {};
	const tools = config?.tools;
	if (tools && typeof tools === 'object') {
		for (const [toolName, toolCfg] of Object.entries(tools)) {
			if (toolCfg && typeof toolCfg === 'object' && typeof toolCfg.approval_mode === 'string') {
				out[toolName] = toolCfg.approval_mode;
			}
		}
	}
	return out;
}

function buildServerRow({
	name,
	config,
	scope,
	sourcePath,
	line,
	disabledLine,
	ignored,
	baseDisabled,
	baseDisabledSource,
}) {
	const overrideDisabled = config?.enabled === false;
	const disabled = baseDisabled === true || overrideDisabled;
	const disabledSource = overrideDisabled
		? `${sourcePath}:${disabledLine ?? line}`
		: baseDisabled === true
			? baseDisabledSource
			: null;
	return {
		name,
		normalizedName: normalizeMcpName(name),
		scope,
		transport: config?.command ? 'stdio' : config?.url ? 'http' : null,
		command: buildCommand(config),
		url: typeof config?.url === 'string' ? config.url : null,
		envKeys: collectEnvKeys(config),
		disabled,
		disabledSource,
		needsAuth: null,
		authCacheMtime: null,
		sourcePath,
		line,
		link: vscodeLink(sourcePath, line),
		startupTimeoutSec: numOrNull(config?.startup_timeout_sec),
		toolTimeoutSec: numOrNull(config?.tool_timeout_sec),
		enabledTools: arrOrEmpty(config?.enabled_tools),
		disabledTools: arrOrEmpty(config?.disabled_tools),
		defaultToolsApprovalMode: strOrNull(config?.default_tools_approval_mode),
		toolApprovalModes: collectToolApprovalModes(config),
		required: boolOrNull(config?.required),
		ignored: ignored === true,
		error: null,
	};
}

function pushTomlServers(servers, toml, sourcePath, scope, ignored) {
	const table = toml.value?.mcp_servers;
	if (!table || typeof table !== 'object') return;
	for (const [name, config] of Object.entries(table)) {
		const line = lineOfTomlKey(toml.locations, ['mcp_servers', name]) ?? 1;
		const disabledLine =
			config?.enabled === false ? lineOfTomlKey(toml.locations, ['mcp_servers', name, 'enabled']) : null;
		servers.push(
			buildServerRow({
				name,
				config,
				scope,
				sourcePath,
				line,
				disabledLine,
				ignored,
				baseDisabled: false,
				baseDisabledSource: null,
			}),
		);
	}
}

/** `<codexHome>/*.config.toml`, excluding the main `config.toml` itself. */
function listProfileConfigPaths(codexHomeDir, mainConfigPath) {
	let entries;
	try {
		entries = fs.readdirSync(codexHomeDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isFile() && e.name.endsWith('.config.toml'))
		.map((e) => path.join(codexHomeDir, e.name))
		.filter((p) => p !== mainConfigPath)
		.sort();
}

/** Resolves one plugin's raw per-server configs from its manifest `mcpServers` field. See module header for the two shapes handled. */
function resolvePluginMcpConfigs(mcpField, pluginPath, manifestFile) {
	if (typeof mcpField === 'string') {
		const mcpJsonPath = path.join(pluginPath, mcpField);
		const file = readJsonFile(mcpJsonPath);
		if (!file.json) return [];
		const wrapped = file.json.mcpServers && typeof file.json.mcpServers === 'object';
		const map = wrapped ? file.json.mcpServers : file.json;
		if (!map || typeof map !== 'object') return [];
		return Object.entries(map).map(([serverName, config]) => {
			const jsonPath = wrapped ? `mcpServers.${serverName}` : serverName;
			return {
				serverName,
				config,
				sourcePath: mcpJsonPath,
				line: lineOf(file.lineIndex, jsonPath),
				disabledLine: config?.enabled === false ? lineOf(file.lineIndex, `${jsonPath}.enabled`) : null,
			};
		});
	}
	if (mcpField && typeof mcpField === 'object' && !Array.isArray(mcpField)) {
		return Object.entries(mcpField).map(([serverName, config]) => ({
			serverName,
			config,
			sourcePath: manifestFile.path,
			line: lineOf(manifestFile.lineIndex, `mcpServers.${serverName}`),
			disabledLine:
				config?.enabled === false ? lineOf(manifestFile.lineIndex, `mcpServers.${serverName}.enabled`) : null,
		}));
	}
	return [];
}

/** Applies `[plugins.<key>.mcp_servers.<server>]` overrides from config.toml onto an already-built plugin-scope row. */
function applyPluginOverride(row, plugin, serverName, userToml, userConfigPath) {
	const overrideTable = userToml.value?.plugins?.[plugin.key]?.mcp_servers?.[serverName];
	if (!overrideTable || typeof overrideTable !== 'object') return;
	if (overrideTable.enabled === false) {
		row.disabled = true;
		const line = lineOfTomlKey(userToml.locations, ['plugins', plugin.key, 'mcp_servers', serverName, 'enabled']);
		row.disabledSource = `${userConfigPath}:${line ?? 1}`;
	} else if (overrideTable.enabled === true) {
		row.disabled = false;
		row.disabledSource = null;
	}
	if (overrideTable.tools && typeof overrideTable.tools === 'object') {
		for (const [toolName, toolCfg] of Object.entries(overrideTable.tools)) {
			if (toolCfg?.approval_mode) row.toolApprovalModes[toolName] = toolCfg.approval_mode;
		}
	}
	if (typeof overrideTable.default_tools_approval_mode === 'string') {
		row.defaultToolsApprovalMode = overrideTable.default_tools_approval_mode;
	}
}

/**
 * @param {{home: string, projectRoot: string}} options
 */
export function scanCodexMcpServers({ home, projectRoot }) {
	const paths = resolveCodexPaths({ home, projectRoot });
	const sources = [];
	const servers = [];

	const userFile = readSourceFile(paths.user.config);
	sources.push({ path: paths.user.config, exists: userFile.exists, error: userFile.error });
	const userToml =
		userFile.readable && userFile.content != null
			? parseToml(userFile.content)
			: { value: {}, locations: new Map(), errors: [] };
	pushTomlServers(servers, userToml, paths.user.config, 'user', false);

	const projectFile = readSourceFile(paths.project.config);
	sources.push({ path: paths.project.config, exists: projectFile.exists, error: projectFile.error });
	if (projectFile.readable && projectFile.content != null) {
		const projectToml = parseToml(projectFile.content);
		pushTomlServers(servers, projectToml, paths.project.config, 'project', false);
	}

	for (const profilePath of listProfileConfigPaths(paths.user.dir, paths.user.config)) {
		const file = readSourceFile(profilePath);
		sources.push({ path: profilePath, exists: file.exists, error: file.error });
		if (!file.readable || file.content == null) continue;
		const toml = parseToml(file.content);
		pushTomlServers(servers, toml, profilePath, 'profile', true);
	}

	const pluginScan = scanCodexPlugins({ home, projectRoot });
	sources.push(...pluginScan.sources);
	for (const plugin of pluginScan.plugins) {
		const manifestFile = readJsonFile(plugin.manifestPath);
		const entries = resolvePluginMcpConfigs(manifestFile.json?.mcpServers, plugin.path, manifestFile);
		const baseDisabled = !plugin.enabled;
		const baseDisabledSource = plugin.enabled
			? null
			: plugin.enabledSource === 'not in config.toml'
				? 'not in config.toml'
				: `${plugin.enabledSource}:${plugin.enabledLine ?? 1}`;

		for (const entry of entries) {
			const row = buildServerRow({
				name: entry.serverName,
				config: entry.config,
				scope: 'plugin',
				sourcePath: entry.sourcePath,
				line: entry.line,
				disabledLine: entry.disabledLine,
				ignored: false,
				baseDisabled,
				baseDisabledSource,
			});
			row.name = `${plugin.name}:${entry.serverName}`;
			row.normalizedName = normalizeMcpName(entry.serverName);
			applyPluginOverride(row, plugin, entry.serverName, userToml, paths.user.config);
			servers.push(row);
		}
	}

	return { servers, sources };
}
