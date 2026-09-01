/**
 * Installed-plugin inventory.
 *
 * Walks <home>/.claude/plugins/{config.json,cache/,repos/} plus the settings
 * cascade's `enabledPlugins` map. Every fact reported here is read straight off
 * disk: a missing config.json, an unparsed plugin.json, or an absent cache
 * directory all surface as real, honest gaps rather than invented defaults.
 *
 * READ ONLY: only fs.readdirSync / fs.lstatSync / fs.statSync and the shared
 * readJsonFile/readSourceFile primitives are used. No write call exists here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, readSourceFile, vscodeLink, estimateTokens } from './source-file.mjs';
import { lineOf } from './json-locate.mjs';
import { resolveLayerPaths, SETTINGS_CASCADE } from './layers.mjs';

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
 * followed. A plugin/skill/marketplace directory reached only through a
 * symlink loads exactly like a real one, so it must not be silently dropped
 * the way a plain `Dirent.isDirectory()` filter would drop it. A broken
 * symlink (or anything that cannot be stat'd) is skipped, same as if the
 * entry did not exist.
 */
function safeSubdirNames(dir) {
	const out = [];
	for (const entry of safeReadDir(dir)) {
		if (entry.isDirectory()) {
			out.push(entry.name);
			continue;
		}
		if (!entry.isSymbolicLink()) continue;
		try {
			if (fs.statSync(path.join(dir, entry.name)).isDirectory()) out.push(entry.name);
		} catch {
			// broken symlink -- not loadable, same as if the entry did not exist
		}
	}
	return out;
}

/**
 * Resolves the winning `enabledPlugins` entry for every plugin key across the
 * settings cascade (user < project < local < enterprise, per layers.mjs
 * SETTINGS_CASCADE — later layers overwrite earlier ones for the same key).
 * A plugin absent from every layer is not "unknown": Claude Code plugins are
 * opt-in, so absence is a determinate disabled state, not a cache miss.
 *
 * @returns {Map<string, {enabled: boolean, sourcePath: string, line: number, link: string}>}
 */
export function resolveEnabledPluginsCascade({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });
	const layerPathById = {
		user: paths.user.settings,
		project: paths.project.settings,
		local: paths.local.settings,
		enterprise: paths.enterprise.managedSettings,
	};

	const winner = new Map();
	for (const layerId of SETTINGS_CASCADE) {
		const filePath = layerPathById[layerId];
		const file = readJsonFile(filePath);
		if (!file.json || typeof file.json.enabledPlugins !== 'object' || file.json.enabledPlugins === null) continue;
		for (const [key, value] of Object.entries(file.json.enabledPlugins)) {
			const line = lineOf(file.lineIndex, `enabledPlugins.${key}`);
			winner.set(key, {
				enabled: Boolean(value),
				sourcePath: filePath,
				line,
				link: vscodeLink(filePath, line),
			});
		}
	}
	return winner;
}

/**
 * The version directory Claude Code RECORDS as installed for the plugin cached
 * at `pluginPath`, or null when nothing declares one.
 *
 * `<home>/.claude/plugins/installed_plugins.json` names an `installPath` per
 * plugin key: an explicit statement of which cached copy is installed, which
 * beats anything inferred from the cache directory's own state. Matching is by
 * path, not by key, so a plugin renamed in its manifest still resolves.
 */
function declaredVersionFor(pluginPath) {
	// <plugins>/cache/<marketplace>/<plugin> -> <plugins>/installed_plugins.json
	const record = readJsonFile(path.resolve(pluginPath, '..', '..', '..', 'installed_plugins.json'));
	const plugins = record.json?.plugins;
	if (!plugins || typeof plugins !== 'object') return null;

	for (const installs of Object.values(plugins)) {
		if (!Array.isArray(installs)) continue;
		for (const install of installs) {
			const installPath = typeof install?.installPath === 'string' ? install.installPath : null;
			if (!installPath) continue;
			if (path.resolve(path.dirname(installPath)) === path.resolve(pluginPath)) return path.basename(installPath);
		}
	}
	return null;
}

/**
 * Picks the "live" version directory when several are cached for one plugin.
 *
 * The installer's own record is consulted first: it SAYS which version is
 * installed, and a declaration beats an inference. Only when nothing declares
 * one — no record, or a record naming a version that is no longer cached — does
 * the `.in_use` heuristic decide. `.in_use` is a reference directory Claude
 * Code touches when it loads a version; several versions can carry one
 * simultaneously (stale sessions), so the most RECENTLY touched `.in_use` wins.
 * Versions without `.in_use` lose to any version that has one; among versions
 * with none, the lexicographically last name wins as a deterministic,
 * non-invented fallback.
 *
 * Exported because three scanners have to agree on which cached copy is the
 * live one: a plugin agent or command listed under a stale version dir is on
 * disk but can never load, and the panel says so with the SAME rule that picks
 * the plugin row, not a second rule that could drift from it.
 */
export function pickActiveVersion(versionDirNames, pluginPath) {
	const declared = declaredVersionFor(pluginPath);
	if (declared && versionDirNames.includes(declared)) return declared;

	let best = null;
	for (const name of versionDirNames) {
		const inUsePath = path.join(pluginPath, name, '.in_use');
		let mtimeMs = -Infinity;
		try {
			mtimeMs = fs.statSync(inUsePath).mtimeMs;
		} catch {
			mtimeMs = -Infinity;
		}
		if (!best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && name > best.name)) {
			best = { name, mtimeMs };
		}
	}
	return best?.name ?? null;
}

/**
 * The ENABLED plugins, each already collapsed to the single cached version
 * directory a session would load. The cheap subset of `scanPlugins` — it reads
 * one plugin.json per plugin and nothing else — for callers that need to know
 * which plugin directories are live without paying for the full contribution
 * inventory. `lib/hooks-scan.mjs` uses it to list plugin-registered hooks.
 *
 * @returns {Array<{key: string, name: string, marketplace: string, version: string, path: string}>}
 */
export function enabledPluginRoots({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });
	const cascade = resolveEnabledPluginsCascade({ home, projectRoot });
	const cacheDir = paths.plugin.cacheDir;
	const roots = [];

	for (const marketplace of safeSubdirNames(cacheDir)) {
		const marketplaceDir = path.join(cacheDir, marketplace);
		for (const pluginName of safeSubdirNames(marketplaceDir)) {
			const pluginParentDir = path.join(marketplaceDir, pluginName);
			const versionNames = safeSubdirNames(pluginParentDir);
			if (versionNames.length === 0) continue;
			const version = pickActiveVersion(versionNames, pluginParentDir) ?? versionNames.sort().at(-1);
			const pluginPath = path.join(pluginParentDir, version);
			const manifest = readJsonFile(path.join(pluginPath, '.claude-plugin', 'plugin.json')).json ?? {};
			const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : pluginName;
			const key = `${name}@${marketplace}`;
			// Plugins are opt-in: absent from every layer means disabled, not unknown.
			if (!(cascade.get(key)?.enabled ?? false)) continue;
			roots.push({ key, name, marketplace, version, path: pluginPath });
		}
	}
	return roots;
}

/** Sums leaf `hooks` array lengths across every event/matcher in a hooks manifest object. */
function countHookActions(hooksManifest) {
	if (!hooksManifest || typeof hooksManifest !== 'object') return 0;
	let count = 0;
	for (const matcherBlocks of Object.values(hooksManifest)) {
		if (!Array.isArray(matcherBlocks)) continue;
		for (const block of matcherBlocks) {
			if (Array.isArray(block?.hooks)) count += block.hooks.length;
		}
	}
	return count;
}

/**
 * Extracts `name`/`description` from a SKILL.md YAML frontmatter block without
 * a YAML dependency. Handles the plain `key: value` case and the folded (`>`)
 * / literal (`|`) block-scalar case actually seen in installed skills.
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

function listContributedNames(dir, filter) {
	return safeReadDir(dir)
		.filter(filter)
		.map((entry) => entry.name.replace(/\.md$/, ''));
}

function readSkills(skillsDir) {
	const names = safeSubdirNames(skillsDir);
	const skills = [];
	for (const name of names) {
		const skillFile = path.join(skillsDir, name, 'SKILL.md');
		const file = readSourceFile(skillFile);
		const frontmatter = parseSkillFrontmatter(file.content);
		skills.push({ name, description: frontmatter.description || '' });
	}
	return skills;
}

/** Reads a plugin-contributed MCP manifest, handling both observed shapes. */
function readPluginMcpServers(pluginPath) {
	const mcpFile = readJsonFile(path.join(pluginPath, '.mcp.json'));
	if (!mcpFile.exists || !mcpFile.json) return [];
	const map =
		mcpFile.json.mcpServers && typeof mcpFile.json.mcpServers === 'object' ? mcpFile.json.mcpServers : mcpFile.json;
	if (!map || typeof map !== 'object') return [];
	return Object.keys(map);
}

/**
 * @param {{home: string, projectRoot: string}} options
 */
export function scanPlugins({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });
	const cascade = resolveEnabledPluginsCascade({ home, projectRoot });

	const cacheDir = paths.plugin.cacheDir;
	const configFile = readJsonFile(paths.plugin.config);
	const sources = {
		config: { path: paths.plugin.config, exists: configFile.exists, error: configFile.error },
		cacheDir: { path: cacheDir, exists: fs.existsSync(cacheDir) },
	};

	const plugins = [];
	// Format-drift bookkeeping: every version dir this loop reaches is a place
	// the documented layout (cache/<marketplace>/<plugin>/<version>/.claude-plugin/
	// plugin.json) says a manifest belongs. `plugins` still gets an entry even
	// when a manifest is missing (name falls back to the directory name), so an
	// empty `plugins` array alone would never distinguish "nothing cached" from
	// "manifests stopped being where the layout says they are".
	let manifestCandidates = 0;
	let manifestsFound = 0;
	const missingManifestPaths = [];
	for (const marketplace of safeSubdirNames(cacheDir)) {
		const marketplaceDir = path.join(cacheDir, marketplace);
		for (const pluginName of safeSubdirNames(marketplaceDir)) {
			const pluginParentDir = path.join(marketplaceDir, pluginName);
			const versionNames = safeSubdirNames(pluginParentDir);
			if (versionNames.length === 0) continue;
			const activeVersion = pickActiveVersion(versionNames, pluginParentDir) ?? versionNames.sort().at(-1);
			const pluginPath = path.join(pluginParentDir, activeVersion);

			const manifestFile = readJsonFile(path.join(pluginPath, '.claude-plugin', 'plugin.json'));
			manifestCandidates += 1;
			if (manifestFile.exists) manifestsFound += 1;
			else if (missingManifestPaths.length < 5)
				missingManifestPaths.push(`${marketplace}/${pluginName}/${activeVersion}`);
			const manifest = manifestFile.json ?? {};
			const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : pluginName;
			const key = `${name}@${marketplace}`;

			const enabledEntry = cascade.get(key) ?? null;
			const enabled = enabledEntry?.enabled ?? false;

			const skills = readSkills(path.join(pluginPath, 'skills'));
			const commands = listContributedNames(
				path.join(pluginPath, 'commands'),
				(e) => e.isFile() && e.name.endsWith('.md'),
			);
			const agents = listContributedNames(path.join(pluginPath, 'agents'), (e) => e.isFile() && e.name.endsWith('.md'));
			const mcpServers = readPluginMcpServers(pluginPath);

			const hooksJsonFile = readJsonFile(path.join(pluginPath, 'hooks', 'hooks.json'));
			const hooksSource = hooksJsonFile.json?.hooks ?? (manifestFile.json ? manifest.hooks : undefined);
			const hooks = countHookActions(hooksSource);

			let listingChars = 0;
			if (enabled) {
				for (const skill of skills) {
					listingChars += skill.name.length + skill.description.length + LISTING_OVERHEAD_CHARS;
				}
			}

			plugins.push({
				key,
				name,
				marketplace,
				version: activeVersion,
				path: pluginPath,
				enabled,
				enabledSource: enabledEntry?.sourcePath ?? null,
				enabledLine: enabledEntry?.line ?? null,
				enabledLink: enabledEntry?.link ?? null,
				contributes: {
					skills: skills.map((s) => s.name),
					commands,
					agents,
					mcpServers,
					hooks,
				},
				listingChars,
				estimatedTokens: enabled ? estimateTokens('x'.repeat(listingChars)) : 0,
				error: manifestFile.error || manifestFile.parseError || null,
			});
		}
	}

	// A marketplace is discoverable two ways: named in extraKnownMarketplaces, or
	// cloned under repos/. The catalogue Claude Code ships with is neither, so a
	// list built from those two sources alone omitted the marketplace that six of
	// the fourteen installed plugins actually came from -- a "where these come
	// from" list missing the biggest source. Anything an installed plugin names
	// is a real marketplace whatever the config says, so add it with the count of
	// plugins vouching for it and a null source, which is the honest record: we
	// know it serves them, and we do not know where it is fetched from.
	const marketplaceList = marketplaces({ home });
	const byName = new Map(marketplaceList.map((entry) => [entry.name, entry]));
	for (const plugin of plugins) {
		const name = plugin.marketplace;
		if (!name) continue;
		const existing = byName.get(name);
		if (existing) {
			existing.servesPlugins = (existing.servesPlugins ?? 0) + 1;
			continue;
		}
		const entry = { name, source: null, path: null, servesPlugins: 1, foundVia: 'installed-plugin' };
		byName.set(name, entry);
		marketplaceList.push(entry);
	}

	const notes = [];
	// This scanner reads an UNDOCUMENTED cache layout. When every version
	// directory found is missing the manifest the layout says belongs there,
	// the honest reading is "the cache layout may have changed", said here in
	// one line -- never a plugin list that quietly renders empty like nothing
	// is installed.
	if (manifestCandidates > 0 && manifestsFound === 0) {
		notes.push(
			`Format drift: found ${manifestCandidates} plugin version director${manifestCandidates === 1 ? 'y' : 'ies'} under ${cacheDir} but no .claude-plugin/plugin.json manifest in any of them (checked, e.g., ${missingManifestPaths.join(', ')}). The plugin cache layout may have changed since this panel was written — the plugin list below may be missing real installs, not reporting their absence.`,
		);
	}

	return { plugins, sources, marketplaces: marketplaceList, notes };
}

/**
 * Known plugin marketplaces: declared in user settings (`extraKnownMarketplaces`)
 * and/or materialized as a cloned directory under <home>/.claude/plugins/repos/.
 * A marketplace can appear in either source alone or both; both are merged by name.
 */
export function marketplaces({ home }) {
	// projectRoot is required by resolveLayerPaths but unused by the fields we
	// read here (user.settings, plugin.reposDir); `home` is a safe placeholder.
	const paths = resolveLayerPaths({ home, projectRoot: home });
	const userSettings = readJsonFile(paths.user.settings);
	const extra =
		userSettings.json?.extraKnownMarketplaces && typeof userSettings.json.extraKnownMarketplaces === 'object'
			? userSettings.json.extraKnownMarketplaces
			: {};

	const reposDir = paths.plugin.reposDir;
	const byName = new Map();
	for (const [name, def] of Object.entries(extra)) {
		byName.set(name, { name, source: def?.source ?? def ?? null, path: path.join(reposDir, name) });
	}
	for (const name of safeSubdirNames(reposDir)) {
		const repoPath = path.join(reposDir, name);
		if (byName.has(name)) {
			byName.get(name).path = repoPath;
		} else {
			byName.set(name, { name, source: null, path: repoPath });
		}
	}
	return [...byName.values()];
}
