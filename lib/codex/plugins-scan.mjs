/**
 * Codex counterpart of `../plugins-scan.mjs`: installed-plugin inventory.
 *
 * Walks `<codexHome>/plugins/cache/<marketplace>/<plugin>/<version>/` and
 * resolves each plugin's enable state from `[plugins."<name>@<marketplace>"]`
 * in `config.toml` -- checked at BOTH the user config
 * (`<codexHome>/config.toml`) and the trusted project config
 * (`<projectRoot>/.codex/config.toml`), project winning when both declare the
 * key. Codex's own config precedence does not denylist `plugins.*` from
 * project layers (see `layers.mjs` `CODEX_SETTINGS_CASCADE`), so this mirrors
 * that ordering rather than reading only the user file.
 *
 * MANIFEST FIELDS ARE NOT UNIFORM: unlike Claude Code's plugin manifests
 * (always separate `skills/`, `commands/`, `agents/` directories),
 * `.codex-plugin/plugin.json` fields observed on this machine are each one
 * of THREE shapes -- absent, a relative path string to a sibling file/dir
 * (`"skills": "./skills/"`, `"mcpServers": "./.mcp.json"`), or an inline
 * object (`"lspServers": {...}`, `"hooks": {}`). Every resolver here handles
 * all three rather than assuming one. No installed manifest on this machine
 * contributes `commands` or `agents` fields -- Codex's plugin architecture
 * does not (yet) define that contribution point, per the 2026-08-26 report --
 * so those two arrays are expected to be empty; the resolver is still generic
 * in case a future plugin does.
 *
 * VERSION SELECTION: Codex's plugin cache carries no per-version "live"
 * marker the way Claude Code's `.in_use` file does. Every plugin observed on
 * this machine has exactly one cached version. When more than one exists,
 * the lexicographically last version name is used as a deterministic
 * fallback -- best-effort, not a confirmed Codex rule -- and every other
 * cached version is reported in `multipleVersions` rather than silently
 * discarded.
 *
 * READ ONLY: fs.readdirSync / fs.statSync and the shared readJsonFile /
 * readSourceFile primitives only. No write call exists here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, readSourceFile, vscodeLink, estimateTokens } from '../source-file.mjs';
import { parseToml, lineOfTomlKey } from './toml.mjs';
import { resolveCodexPaths } from './layers.mjs';

const LISTING_OVERHEAD_CHARS = 8;

function safeReadDir(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * Directory-entry names under `dir` that resolve to a directory, symlinks
 * followed. A symlink that points at a SIBLING directory (the plugin cache's
 * `latest -> 26.810.50856`) is an alias, not a second version: listing it would
 * make the panel show "latest" as the active version and break every path
 * comparison against the injected catalog, which uses the real name.
 */
function safeSubdirNames(dir) {
	const entries = safeReadDir(dir);
	const real = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
	const out = [...real];
	let realDir = null;
	try {
		realDir = fs.realpathSync(dir);
	} catch {
		realDir = null;
	}
	for (const entry of entries) {
		if (!entry.isSymbolicLink()) continue;
		const full = path.join(dir, entry.name);
		try {
			if (!fs.statSync(full).isDirectory()) continue;
			const target = fs.realpathSync(full);
			if (realDir && path.dirname(target) === realDir && real.has(path.basename(target))) continue;
			out.push(entry.name);
		} catch {
			// broken symlink -- not loadable, same as if the entry did not exist
		}
	}
	return out;
}

function readConfigToml(configPath) {
	const file = readSourceFile(configPath);
	if (!file.readable || file.content == null) {
		return { value: {}, locations: new Map(), exists: file.exists, error: file.error };
	}
	const { value, locations, errors } = parseToml(file.content);
	return { value, locations, exists: true, error: errors.length > 0 ? `${errors.length} TOML parse error(s)` : null };
}

/**
 * Resolves the winning `[plugins."<key>"].enabled` across user then project
 * config.toml -- project overwrites user for the same key, matching
 * `CODEX_SETTINGS_CASCADE`'s user < project ordering (`layers.mjs`).
 */
function resolveEnabledCascade(layers) {
	const winner = new Map();
	for (const { toml, configPath } of layers) {
		const pluginsTable = toml.value?.plugins;
		if (!pluginsTable || typeof pluginsTable !== 'object') continue;
		for (const [key, entry] of Object.entries(pluginsTable)) {
			if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'enabled')) continue;
			const line = lineOfTomlKey(toml.locations, ['plugins', key, 'enabled']);
			winner.set(key, { enabled: entry.enabled === true, sourcePath: configPath, line });
		}
	}
	return winner;
}

/** Picks the cached version to report as "the" install. See module header. */
function pickActiveVersion(versionNames) {
	if (versionNames.length <= 1) return versionNames[0] ?? null;
	return [...versionNames].sort().at(-1);
}

/**
 * Extracts `name`/`description` from a SKILL.md YAML frontmatter block without
 * a YAML dependency. Same hand-rolled reader as ../plugins-scan.mjs -- kept as
 * a local copy rather than a cross-harness import so this module has no
 * dependency on Claude's own scanner.
 */
function parseSkillFrontmatter(content) {
	const result = { name: '', description: '' };
	if (typeof content !== 'string') return result;
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return result;
	const lines = match[1].split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const keyMatch = line.match(/^([A-Za-z][\w-]*):\s?(.*)$/);
		if (!keyMatch) {
			i += 1;
			continue;
		}
		const [, key, rawValue] = keyMatch;
		if (key !== 'name' && key !== 'description') {
			i += 1;
			continue;
		}
		const value = rawValue.trim();
		if (value === '>' || value === '>-' || value === '|' || value === '|-') {
			const folded = value.startsWith('>');
			const collected = [];
			i += 1;
			while (i < lines.length && (lines[i] === '' || /^\s+/.test(lines[i]))) {
				collected.push(lines[i].trim());
				i += 1;
			}
			result[key] = folded ? collected.join(' ').trim() : collected.join('\n').trim();
			continue;
		}
		result[key] = value.replace(/^['"]|['"]$/g, '');
		i += 1;
	}
	return result;
}

/**
 * Resolves a manifest-declared relative path against `pluginPath` and returns
 * the resolved absolute path -- but ONLY when it stays inside the plugin
 * directory. Returns null on any escape (`"../../.."`, an absolute path
 * elsewhere, a symlink that hops out), so a hostile or malformed manifest
 * cannot make this read-only panel list a directory outside the plugin.
 *
 * Resolution goes through `fs.realpathSync` when the target exists, so a
 * symlink cannot launder an escape past the syntactic `path.resolve` check;
 * when it does not exist yet, the normalized `path.resolve` result is used
 * instead (there is nothing to realpath, and the syntactic path is still the
 * best available signal of intent).
 */
function containedPath(pluginPath, value) {
	if (typeof value !== 'string' || value.length === 0) return null;

	const target = path.resolve(pluginPath, value);
	let resolvedTarget = target;
	try {
		resolvedTarget = fs.realpathSync(target);
	} catch {
		// Does not exist (yet) -- fall back to the normalized syntactic path.
	}

	let resolvedRoot = pluginPath;
	try {
		resolvedRoot = fs.realpathSync(pluginPath);
	} catch {
		// The plugin directory itself should exist, but fall back safely if not.
	}

	if (resolvedTarget === resolvedRoot) return resolvedTarget;
	const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
	return resolvedTarget.startsWith(prefix) ? resolvedTarget : null;
}

/** `manifest.skills`: absent, `"./skills/"` (a directory of SKILL.md dirs), or an inline name array. */
function resolveSkills(manifestValue, pluginPath, manifestErrors) {
	if (typeof manifestValue === 'string') {
		const skillsDir = containedPath(pluginPath, manifestValue);
		if (skillsDir === null) {
			manifestErrors.push('skills path escapes the plugin directory');
			return [];
		}
		return safeSubdirNames(skillsDir).map((name) => {
			const file = readSourceFile(path.join(skillsDir, name, 'SKILL.md'));
			const fm = parseSkillFrontmatter(file.content);
			return { name, description: fm.description || '' };
		});
	}
	if (Array.isArray(manifestValue)) {
		return manifestValue.filter((v) => typeof v === 'string').map((name) => ({ name, description: '' }));
	}
	return [];
}

/** `manifest.commands` / `manifest.agents`: absent, a dir-of-*.md path string, an inline array, or an inline object. */
function resolveNameListField(manifestValue, pluginPath, manifestErrors, fieldName) {
	if (typeof manifestValue === 'string') {
		const dir = containedPath(pluginPath, manifestValue);
		if (dir === null) {
			manifestErrors.push(`${fieldName} path escapes the plugin directory`);
			return [];
		}
		return safeReadDir(dir)
			.filter((e) => e.isFile() && e.name.endsWith('.md'))
			.map((e) => e.name.replace(/\.md$/, ''));
	}
	if (Array.isArray(manifestValue)) return manifestValue.filter((v) => typeof v === 'string');
	if (manifestValue && typeof manifestValue === 'object') return Object.keys(manifestValue);
	return [];
}

/** `manifest.mcpServers`: absent, a sibling-JSON path string (optionally `{mcpServers:{...}}`-wrapped), or an inline map. */
function resolveNamedMap(manifestValue, pluginPath, wrapperKey, manifestErrors, fieldName) {
	if (typeof manifestValue === 'string') {
		const filePath = containedPath(pluginPath, manifestValue);
		if (filePath === null) {
			manifestErrors.push(`${fieldName} path escapes the plugin directory`);
			return [];
		}
		const file = readJsonFile(filePath);
		if (!file.json) return [];
		const map =
			wrapperKey && file.json[wrapperKey] && typeof file.json[wrapperKey] === 'object'
				? file.json[wrapperKey]
				: file.json;
		return map && typeof map === 'object' ? Object.keys(map) : [];
	}
	if (manifestValue && typeof manifestValue === 'object' && !Array.isArray(manifestValue))
		return Object.keys(manifestValue);
	return [];
}

/**
 * `manifest.apps`: absent, a sibling-JSON path string, or an inline object.
 * The `.app.json` shape is unconfirmed on this machine (no installed plugin
 * uses it as a string reference yet); this treats a single `{id|name, ...}`
 * object as one app, and an object whose every value is itself an object as
 * an id -> definition map, matching the two shapes every other manifest
 * field uses elsewhere in this file.
 */
function resolveApps(manifestValue, pluginPath, manifestErrors) {
	let obj = manifestValue;
	if (typeof manifestValue === 'string') {
		const filePath = containedPath(pluginPath, manifestValue);
		if (filePath === null) {
			manifestErrors.push('apps path escapes the plugin directory');
			return [];
		}
		const file = readJsonFile(filePath);
		obj = file.json;
	}
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
	if (typeof obj.id === 'string' || typeof obj.name === 'string') return [obj.id || obj.name];
	const allDefs = Object.values(obj).every((v) => v && typeof v === 'object');
	return allDefs ? Object.keys(obj) : [];
}

/** `manifest.lspServers`: an inline id -> definition map (only shape observed). */
function resolveLspServers(manifestValue) {
	return manifestValue && typeof manifestValue === 'object' && !Array.isArray(manifestValue)
		? Object.keys(manifestValue)
		: [];
}

/** `manifest.hooks`: absent, an inline event -> matcher-blocks map (Claude hooks.json shape), or a path to one. */
function resolveHooks(manifestValue, pluginPath, manifestErrors) {
	let hooksObj = manifestValue;
	if (typeof manifestValue === 'string') {
		const filePath = containedPath(pluginPath, manifestValue);
		if (filePath === null) {
			manifestErrors.push('hooks path escapes the plugin directory');
			return [];
		}
		const file = readJsonFile(filePath);
		hooksObj = file.json;
	}
	if (!hooksObj || typeof hooksObj !== 'object') return [];
	return Object.entries(hooksObj)
		.filter(([, blocks]) => Array.isArray(blocks) && blocks.length > 0)
		.map(([event]) => event);
}

function scanMarketplaces({ paths, userToml }) {
	const byName = new Map();
	const table = userToml.value?.marketplaces;
	if (table && typeof table === 'object') {
		for (const [name, def] of Object.entries(table)) {
			const line = lineOfTomlKey(userToml.locations, ['marketplaces', name]);
			byName.set(name, {
				name,
				sourceType: typeof def?.source_type === 'string' ? def.source_type : null,
				source: typeof def?.source === 'string' ? def.source : null,
				lastUpdated: typeof def?.last_updated === 'string' ? def.last_updated : null,
				lastRevision: typeof def?.last_revision === 'string' ? def.last_revision : null,
				path: null,
				line,
				link: line ? vscodeLink(paths.user.config, line) : null,
			});
		}
	}
	for (const name of safeSubdirNames(paths.plugin.sourcesDir)) {
		const sourceDirPath = path.join(paths.plugin.sourcesDir, name);
		if (byName.has(name)) {
			byName.get(name).path = sourceDirPath;
		} else {
			byName.set(name, {
				name,
				sourceType: 'local',
				source: sourceDirPath,
				lastUpdated: null,
				lastRevision: null,
				path: sourceDirPath,
				line: null,
				link: null,
			});
		}
	}
	return [...byName.values()];
}

/**
 * @param {{home: string, projectRoot: string}} options
 */
export function scanCodexPlugins({ home, projectRoot }) {
	const paths = resolveCodexPaths({ home, projectRoot });
	const userToml = readConfigToml(paths.user.config);
	const projectToml = readConfigToml(paths.project.config);

	const sources = [
		{ path: paths.user.config, exists: userToml.exists, error: userToml.error },
		{ path: paths.project.config, exists: projectToml.exists, error: projectToml.error },
		{ path: paths.plugin.cacheDir, exists: fs.existsSync(paths.plugin.cacheDir), error: null },
		{ path: paths.plugin.sourcesDir, exists: fs.existsSync(paths.plugin.sourcesDir), error: null },
	];

	const cascade = resolveEnabledCascade([
		{ toml: userToml, configPath: paths.user.config },
		{ toml: projectToml, configPath: paths.project.config },
	]);

	const plugins = [];
	for (const marketplace of safeSubdirNames(paths.plugin.cacheDir)) {
		const marketplaceDir = path.join(paths.plugin.cacheDir, marketplace);
		for (const pluginDirName of safeSubdirNames(marketplaceDir)) {
			const pluginParentDir = path.join(marketplaceDir, pluginDirName);
			const versionNames = safeSubdirNames(pluginParentDir);
			if (versionNames.length === 0) continue;
			const activeVersion = pickActiveVersion(versionNames);
			const pluginPath = path.join(pluginParentDir, activeVersion);

			const manifestPath = path.join(pluginPath, '.codex-plugin', 'plugin.json');
			const manifestFile = readJsonFile(manifestPath);
			const manifest = manifestFile.json ?? {};
			const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : pluginDirName;
			const key = `${name}@${marketplace}`;

			const enabledEntry = cascade.get(key) ?? null;
			const enabled = enabledEntry?.enabled ?? false;

			const manifestErrors = [];
			const skills = resolveSkills(manifest.skills, pluginPath, manifestErrors);
			let listingChars = 0;
			for (const skill of skills) listingChars += skill.name.length + skill.description.length + LISTING_OVERHEAD_CHARS;

			plugins.push({
				key,
				name,
				marketplace,
				version: activeVersion,
				path: pluginPath,
				enabled,
				enabledSource: enabledEntry ? enabledEntry.sourcePath : 'not in config.toml',
				enabledLine: enabledEntry?.line ?? null,
				enabledLink: enabledEntry?.line ? vscodeLink(enabledEntry.sourcePath, enabledEntry.line) : null,
				contributes: {
					skills: skills.map((s) => s.name),
					commands: resolveNameListField(manifest.commands, pluginPath, manifestErrors, 'commands'),
					agents: resolveNameListField(manifest.agents, pluginPath, manifestErrors, 'agents'),
					hooks: resolveHooks(manifest.hooks, pluginPath, manifestErrors),
					mcpServers: resolveNamedMap(manifest.mcpServers, pluginPath, 'mcpServers', manifestErrors, 'mcpServers'),
					apps: resolveApps(manifest.apps, pluginPath, manifestErrors),
					lspServers: resolveLspServers(manifest.lspServers),
				},
				estimatedTokens: estimateTokens('x'.repeat(listingChars)),
				manifestPath,
				multipleVersions: versionNames.filter((v) => v !== activeVersion),
				error: manifestFile.error || manifestFile.parseError || null,
				manifestErrors,
			});
		}
	}

	return { plugins, sources, marketplaces: scanMarketplaces({ paths, userToml }) };
}
