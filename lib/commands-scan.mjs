/**
 * Discovers slash commands across the three places Claude Code loads them
 * from: user commands, project commands (including namespaced
 * subdirectories, e.g. `commands/opsx/apply.md` -> `opsx:apply`), and plugin
 * commands cached under `<home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/`
 * (namespaced `<plugin>:<name>`).
 *
 * READ ONLY: `fs.readdirSync`, `fs.statSync` and `fs.readFileSync` only.
 * A missing commands directory is a normal, common state (most machines have
 * no user-level commands at all) so it is reported as an empty list plus a
 * note, never thrown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, vscodeLink } from './source-file.mjs';
import { resolveLayerPaths } from './layers.mjs';
import { pickActiveVersion } from './plugins-scan.mjs';

const FRONTMATTER_FENCE = '---';

/**
 * Recursively lists every `.md` file under `rootDir`. Returns an empty array
 * for a directory that cannot be read (missing, not a directory, permission
 * denied) — the caller decides whether that is worth a note.
 */
function walkMarkdownFiles(rootDir) {
	const results = [];

	function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				results.push(abs);
			}
		}
	}

	walk(rootDir);
	return results;
}

function directoryExists(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Strips one layer of matching quotes (`"..."` or `'...'`) from a scalar value. */
function unquote(value) {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Hand-rolled parse of the leading `---` frontmatter fence. Reads
 * `description`, `disable-model-invocation`, `argument-hint` and
 * `allowed-tools` as flat `key: value` lines; anything else in the block is
 * ignored. A missing or unterminated fence yields all-defaults, never an
 * error — most command files have no frontmatter at all.
 */
function parseFrontmatter(content) {
	const defaults = { description: null, disableModelInvocation: false, argumentHint: null, allowedTools: null };
	if (typeof content !== 'string') return defaults;

	const lines = content.split('\n');
	if (lines[0]?.trim() !== FRONTMATTER_FENCE) return defaults;

	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trim() === FRONTMATTER_FENCE) {
			end = i;
			break;
		}
	}
	if (end === -1) return defaults;

	const result = { ...defaults };
	for (let i = 1; i < end; i += 1) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
		if (!match) continue;
		const key = match[1];
		const value = unquote(match[2].trim());

		if (key === 'description') result.description = value.length > 0 ? value : null;
		else if (key === 'disable-model-invocation') result.disableModelInvocation = value.toLowerCase() === 'true';
		else if (key === 'argument-hint') result.argumentHint = value.length > 0 ? value : null;
		else if (key === 'allowed-tools') result.allowedTools = value.length > 0 ? value : null;
	}
	return result;
}

/** Path segments relative to `dir`, minus the `.md` extension, joined with `:`. */
function namespacedName(absPath, dir) {
	const relative = path.relative(dir, absPath);
	const parts = relative.split(path.sep);
	parts[parts.length - 1] = parts[parts.length - 1].replace(/\.md$/, '');
	return parts.join(':');
}

function buildCommandRow({ absPath, dir, layer, namePrefix, pluginVersion = null, activeVersion = null }) {
	const file = readSourceFile(absPath);
	const localName = namespacedName(absPath, dir);
	const name = namePrefix ? `${namePrefix}:${localName}` : localName;
	const meta = file.readable && file.content != null ? parseFrontmatter(file.content) : parseFrontmatter(null);

	return {
		name,
		layer,
		// Both null on a user/project row: those are not version-scoped, so
		// "is this the active version" is not a question that applies to them.
		pluginVersion,
		activeVersion,
		path: absPath,
		line: 1,
		link: vscodeLink(absPath, 1),
		description: meta.description,
		disableModelInvocation: meta.disableModelInvocation,
		argumentHint: meta.argumentHint,
		allowedTools: meta.allowedTools,
		bytes: file.size,
		error: file.error,
	};
}

/**
 * Scans one commands directory (user or project layer, or one plugin
 * version's `commands/` dir) and returns its rows plus any note about the
 * directory itself being absent.
 */
function scanCommandsDir({
	dir,
	layer,
	namePrefix = null,
	noteIfMissing = null,
	pluginVersion = null,
	activeVersion = null,
}) {
	if (!directoryExists(dir)) {
		return { commands: [], notes: noteIfMissing ? [noteIfMissing] : [] };
	}
	const files = walkMarkdownFiles(dir);
	const commands = files.map((absPath) =>
		buildCommandRow({ absPath, dir, layer, namePrefix, pluginVersion, activeVersion }),
	);
	return { commands, notes: [] };
}

/** Walks `<home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/`. */
function scanPluginCommands(pluginsCacheDir) {
	const commands = [];
	const notes = [];

	if (!directoryExists(pluginsCacheDir)) {
		notes.push(`plugin cache directory not found: ${pluginsCacheDir}`);
		return { commands, notes };
	}

	let marketplaces;
	try {
		marketplaces = fs.readdirSync(pluginsCacheDir, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch (error) {
		notes.push(`could not read plugin cache directory ${pluginsCacheDir}: ${String(error?.message || error)}`);
		return { commands, notes };
	}

	for (const marketplaceEntry of marketplaces) {
		const marketplaceDir = path.join(pluginsCacheDir, marketplaceEntry.name);
		let plugins;
		try {
			plugins = fs.readdirSync(marketplaceDir, { withFileTypes: true }).filter((e) => e.isDirectory());
		} catch {
			continue;
		}

		for (const pluginEntry of plugins) {
			const pluginDir = path.join(marketplaceDir, pluginEntry.name);
			let versions;
			try {
				versions = fs.readdirSync(pluginDir, { withFileTypes: true }).filter((e) => e.isDirectory());
			} catch {
				continue;
			}

			// Every cached version is walked — this scanner reports what is on
			// disk, and a plugin with five cached versions really does carry five
			// copies of each command file. Only one of them can ever load, so each
			// row says which it is, resolved with plugins-scan's own rule rather
			// than a second rule that could drift from the Plugins section.
			const versionNames = versions.map((entry) => entry.name);
			const active = pickActiveVersion(versionNames, pluginDir) ?? [...versionNames].sort().at(-1) ?? null;
			for (const versionEntry of versions) {
				const commandsDir = path.join(pluginDir, versionEntry.name, 'commands');
				// Most plugin versions have no commands/ dir at all (agents-only,
				// skills-only plugins) — that is normal, not worth a note per version.
				const scanned = scanCommandsDir({
					dir: commandsDir,
					layer: 'plugin',
					namePrefix: pluginEntry.name,
					pluginVersion: versionEntry.name,
					activeVersion: versionEntry.name === active,
				});
				commands.push(...scanned.commands);
			}
		}
	}

	return { commands, notes };
}

/**
 * @param {{home: string, projectRoot: string}} options
 * @returns {{commands: Array<object>, notes: string[]}}
 */
export function scanCommands({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });
	const commands = [];
	const notes = [];

	const user = scanCommandsDir({
		dir: paths.user.commandsDir,
		layer: 'user',
		noteIfMissing: `user commands directory not found: ${paths.user.commandsDir}`,
	});
	commands.push(...user.commands);
	notes.push(...user.notes);

	const project = scanCommandsDir({
		dir: paths.project.commandsDir,
		layer: 'project',
		noteIfMissing: `project commands directory not found: ${paths.project.commandsDir}`,
	});
	commands.push(...project.commands);
	notes.push(...project.notes);

	const plugin = scanPluginCommands(paths.plugin.cacheDir);
	commands.push(...plugin.commands);
	notes.push(...plugin.notes);

	return { commands, notes };
}
