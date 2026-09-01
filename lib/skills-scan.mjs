/**
 * Skill discovery and state resolution.
 *
 * A skill is visible to the harness from three layers:
 *   user    -> <home>/.claude/skills/<name>/SKILL.md
 *   project -> <projectRoot>/.claude/skills/<name>/SKILL.md
 *   plugin  -> <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
 *
 * Two things make this scanner more than a directory walk:
 *
 *   STATE: `skillOverrides` in the settings cascade (user < project < local,
 *   local wins) can hide a skill from the model, strip its description, or
 *   hide it entirely. A typo'd override key silently does nothing, so every
 *   override is checked against a real discovered skill; the ones that match
 *   nothing come back as `orphanOverrides` instead of vanishing.
 *
 *   SHADOWING: the same skill name can exist at both user and project scope.
 *   Claude Code loads only the project copy (project wins), so the user copy
 *   is a dead file -- editing it silently does nothing. `duplicates` surfaces
 *   every such pair with a byte-for-byte `identical` check, because a drifted
 *   duplicate is a worse trap than an identical one.
 *
 *   CACHED VERSIONS: a plugin keeps every version it has ever installed under
 *   the cache, so five cached versions carry five copies of each SKILL.md.
 *   Only the active one loads, so every plugin row carries `pluginVersion` and
 *   `activeVersion` -- the same tags agents-scan and commands-scan already
 *   emit, resolved by the same `pickActiveVersion` rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, readJsonFile, readSourceFile, vscodeLink } from './source-file.mjs';
import { lineOf } from './json-locate.mjs';
import { resolveLayerPaths, winningLayer } from './layers.mjs';
import { pickActiveVersion } from './plugins-scan.mjs';

const VALID_STATES = new Set(['on', 'name-only', 'user-invocable-only', 'off']);
const VISIBLE_STATES = new Set(['on', 'name-only']);
const LISTING_OVERHEAD_CHARS = 8;

/**
 * Directory entries of `dir` that resolve to a directory, symlinks followed.
 * Claude Code loads a skill through a symlinked directory exactly like a real
 * one, so a symlink entry counts here too -- it carries `isSymlink: true` and
 * `symlinkTarget` (its resolved real path) so the caller can surface it. A
 * broken symlink (or anything that cannot be stat'd) is silently skipped, the
 * same as a missing directory: Claude Code cannot load it either.
 */
function listSubdirEntries(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		if (entry.isDirectory()) {
			out.push({ name: entry.name, isSymlink: false, symlinkTarget: null });
			continue;
		}
		if (!entry.isSymbolicLink()) continue;
		const entryPath = path.join(dir, entry.name);
		try {
			if (fs.statSync(entryPath).isDirectory()) {
				out.push({ name: entry.name, isSymlink: true, symlinkTarget: fs.realpathSync(entryPath) });
			}
		} catch {
			// broken symlink -- not loadable, same as if the entry did not exist
		}
	}
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Sorted subdirectory names of `dir` (symlinks-to-directories included), or `[]`. */
function listSubdirs(dir) {
	return listSubdirEntries(dir).map((entry) => entry.name);
}

function stripQuotes(value) {
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
 * Hand-rolled frontmatter reader: no YAML dependency, just enough to pull flat
 * `key: value` pairs (plus folded multi-line continuations) out of a `---`
 * fenced block. Returns a Map of key -> { value, line, continuationLines }.
 */
function parseFrontmatter(content) {
	const attrs = new Map();
	const lines = typeof content === 'string' ? content.split('\n') : [];
	if ((lines[0] ?? '').trim() !== '---') return attrs;

	let closeIndex = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trim() === '---') {
			closeIndex = i;
			break;
		}
	}
	if (closeIndex === -1) return attrs;

	let currentKey = null;
	for (let i = 1; i < closeIndex; i += 1) {
		const raw = lines[i];
		const isIndented = /^[ \t]/.test(raw);
		const keyMatch = !isIndented ? /^([A-Za-z_][\w-]*):[ \t]?(.*)$/.exec(raw) : null;
		if (keyMatch) {
			const key = keyMatch[1];
			attrs.set(key, { value: stripQuotes(keyMatch[2].trim()), line: i + 1, continuationLines: [] });
			currentKey = key;
			continue;
		}
		const trimmed = raw.trim();
		if (currentKey && trimmed.length > 0) {
			attrs.get(currentKey).continuationLines.push(trimmed);
		}
	}

	// Fold plain multi-line scalars (not YAML lists) into one string, joined
	// by a single space -- exactly what a folded (`>`) or plain multi-line
	// YAML scalar means, and what a description spilling across lines needs.
	for (const entry of attrs.values()) {
		if (entry.continuationLines.length === 0) continue;
		const isList = entry.continuationLines.every((line) => line.startsWith('- '));
		if (isList) continue;
		const isBlockIndicator = entry.value === '>' || entry.value === '>-' || entry.value === '|' || entry.value === '|-';
		const extra = entry.continuationLines.join(' ');
		entry.value = entry.value.length > 0 && !isBlockIndicator ? `${entry.value} ${extra}` : extra;
	}

	return attrs;
}

/**
 * Every plugin skill file on disk, each tagged with the cached version it came
 * from and whether that version is the one a session would actually load.
 *
 * All versions are walked on purpose: this scanner reports what is on disk, and
 * a plugin with five cached versions really does carry five copies of each
 * SKILL.md. But only one of them can ever load, so each row says which it is
 * — using `pickActiveVersion` from plugins-scan, the same rule that picks the
 * version shown in the Plugins section, never a second rule that could drift.
 * Without this tag five cached versions rendered as five indistinguishable
 * rows of the same skill, which reads as five skills.
 */
function listPluginSkillFiles(cacheDir) {
	const files = [];
	for (const marketplace of listSubdirs(cacheDir)) {
		const marketplaceDir = path.join(cacheDir, marketplace);
		for (const plugin of listSubdirs(marketplaceDir)) {
			const pluginDir = path.join(marketplaceDir, plugin);
			const versions = listSubdirs(pluginDir);
			const active = pickActiveVersion(versions, pluginDir) ?? [...versions].sort().at(-1) ?? null;
			for (const version of versions) {
				const skillsDir = path.join(pluginDir, version, 'skills');
				for (const name of listSubdirs(skillsDir)) {
					files.push({
						plugin,
						skillPath: path.join(skillsDir, name, 'SKILL.md'),
						pluginVersion: version,
						activeVersion: version === active,
					});
				}
			}
		}
	}
	return files;
}

function buildSkillEntry({
	dirName,
	layer,
	plugin,
	skillPath,
	isSymlink = false,
	symlinkTarget = null,
	pluginVersion = null,
	activeVersion = null,
}) {
	const file = readSourceFile(skillPath);
	const entry = {
		name: dirName,
		qualifiedName: plugin ? `${plugin}:${dirName}` : dirName,
		layer,
		plugin: plugin ?? null,
		// Both null on a user/project row: those are not version-scoped, so
		// calling one an "active version" would answer a question that does not
		// apply. `activeVersion === false` is the only value meaning "stale".
		pluginVersion,
		activeVersion,
		path: skillPath,
		line: 1,
		link: vscodeLink(skillPath, 1),
		description: '',
		// Placeholder, using the un-overridden 'on' state -- resolveListingChars()
		// recomputes this once the final state and the skillListingMaxDescChars
		// cap are known.
		listingChars: dirName.length + LISTING_OVERHEAD_CHARS,
		estimatedTokens: 0,
		disableModelInvocation: false,
		state: 'on',
		stateSource: null,
		stateLine: null,
		stateLink: null,
		shadowedBy: null,
		isSymlink,
		symlinkTarget,
		error: file.error,
	};
	if (!file.readable || file.content == null) return entry;

	const attrs = parseFrontmatter(file.content);
	const nameAttr = attrs.get('name');
	const descAttr = attrs.get('description');
	const disableAttr = attrs.get('disable-model-invocation');

	const resolvedName = nameAttr?.value || dirName;
	const description = descAttr?.value ?? '';

	entry.name = resolvedName;
	entry.qualifiedName = plugin ? `${plugin}:${resolvedName}` : resolvedName;
	entry.line = descAttr?.line ?? nameAttr?.line ?? 1;
	entry.link = vscodeLink(skillPath, entry.line);
	entry.description = description;
	entry.listingChars = resolvedName.length + description.length + LISTING_OVERHEAD_CHARS;
	entry.estimatedTokens = estimateTokens('x'.repeat(entry.listingChars));
	entry.disableModelInvocation = disableAttr?.value === 'true';

	return entry;
}

/**
 * Listing cost as the model actually receives it, not as a flat name+desc+8
 * formula pretends: a `name-only` override state (skillOverrides, resolved
 * earlier in scanSkills) drops the description from the listing entirely, and
 * `skillListingMaxDescChars` -- read off the same settings cascade as every
 * other override -- caps whatever description IS sent. Text past that cap
 * never reaches the model, so it must not be counted either.
 */
function resolveListingChars(skill, maxDescChars) {
	if (skill.state === 'name-only') return skill.name.length + LISTING_OVERHEAD_CHARS;
	const cap = Number.isFinite(maxDescChars) ? maxDescChars : Infinity;
	const descChars = Math.min(skill.description.length, cap);
	return skill.name.length + descChars + LISTING_OVERHEAD_CHARS;
}

/** Reads `skillOverrides` and `disableBundledSkills` off one settings.json/.local.json layer. */
function readSettingsLayer(layer, absPath) {
	const file = readJsonFile(absPath);
	return {
		layer,
		path: absPath,
		exists: file.exists,
		json: file.json,
		lineIndex: file.lineIndex,
	};
}

/**
 * Lifetime usage counters, read from `skillUsage` in ~/.claude.json.
 *
 * Two caveats the panel must not paper over:
 *   - `usageCount` is a LIFETIME total since install. It is never windowed and
 *     never resets, so it answers "have I ever used this", not "do I use it
 *     lately". `lastUsedAt` is the recency signal, and unlike pluginUsage it is
 *     written only on real dispatch, so it is trustworthy.
 *   - a skill under a directory can be recorded under its qualified name
 *     (`plugin:name`) OR its bare name, so both keys are checked before
 *     concluding a skill was never used.
 */
function readSkillUsage(home) {
	const config = readJsonFile(path.join(home, '.claude.json'));
	const usage = config.json?.skillUsage;
	if (!usage || typeof usage !== 'object') {
		return { map: new Map(), sourcePath: config.path, available: false, error: config.parseError || config.error };
	}
	return {
		map: new Map(Object.entries(usage)),
		sourcePath: config.path,
		available: true,
		error: null,
	};
}

function attachUsage(skill, usage) {
	const hit = usage.map.get(skill.qualifiedName) ?? usage.map.get(skill.name) ?? null;
	const count = Number(hit?.usageCount);
	const last = Number(hit?.lastUsedAt);
	return {
		...skill,
		usageCount: Number.isFinite(count) ? count : 0,
		lastUsedAt: Number.isFinite(last) && last > 0 ? last : null,
		usageKnown: usage.available,
	};
}

export function scanSkills({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });

	const discovered = [];
	for (const entry of listSubdirEntries(paths.user.skillsDir)) {
		discovered.push(
			buildSkillEntry({
				dirName: entry.name,
				layer: 'user',
				plugin: null,
				skillPath: path.join(paths.user.skillsDir, entry.name, 'SKILL.md'),
				isSymlink: entry.isSymlink,
				symlinkTarget: entry.symlinkTarget,
			}),
		);
	}
	for (const entry of listSubdirEntries(paths.project.skillsDir)) {
		discovered.push(
			buildSkillEntry({
				dirName: entry.name,
				layer: 'project',
				plugin: null,
				skillPath: path.join(paths.project.skillsDir, entry.name, 'SKILL.md'),
				isSymlink: entry.isSymlink,
				symlinkTarget: entry.symlinkTarget,
			}),
		);
	}
	for (const { plugin, skillPath, pluginVersion, activeVersion } of listPluginSkillFiles(paths.plugin.cacheDir)) {
		const dirName = path.basename(path.dirname(skillPath));
		discovered.push(buildSkillEntry({ dirName, layer: 'plugin', plugin, skillPath, pluginVersion, activeVersion }));
	}

	// Settings cascade, weakest first -- later entries win per key.
	const settingsLayers = [
		readSettingsLayer('user', paths.user.settings),
		readSettingsLayer('project', paths.project.settings),
		readSettingsLayer('local', paths.local.settings),
	];

	const overridesByKey = new Map(); // name -> { value, layer, path, line, link }
	for (const settingsLayer of settingsLayers) {
		const overrides = settingsLayer.json?.skillOverrides;
		if (!overrides || typeof overrides !== 'object') continue;
		for (const [name, value] of Object.entries(overrides)) {
			const line = lineOf(settingsLayer.lineIndex, `skillOverrides.${name}`);
			overridesByKey.set(name, {
				value,
				layer: settingsLayer.layer,
				path: settingsLayer.path,
				line,
				link: vscodeLink(settingsLayer.path, line),
			});
		}
	}

	let disableBundledSkills = { value: false, sourcePath: null, sourceLine: null, sourceLink: null };
	for (const settingsLayer of settingsLayers) {
		if (settingsLayer.json && Object.hasOwn(settingsLayer.json, 'disableBundledSkills')) {
			const line = lineOf(settingsLayer.lineIndex, 'disableBundledSkills');
			disableBundledSkills = {
				value: Boolean(settingsLayer.json.disableBundledSkills),
				sourcePath: settingsLayer.path,
				sourceLine: line,
				sourceLink: vscodeLink(settingsLayer.path, line),
			};
		}
	}

	// skillListingMaxDescChars caps the description text the listing sends per
	// skill. Same cascade, same later-wins rule as skillOverrides above. When no
	// layer sets it, no cap applies -- the full description is what the model
	// gets, so that is what gets counted.
	let skillListingMaxDescChars = { value: null, sourcePath: null, sourceLine: null, sourceLink: null };
	for (const settingsLayer of settingsLayers) {
		if (settingsLayer.json && Object.hasOwn(settingsLayer.json, 'skillListingMaxDescChars')) {
			const raw = Number(settingsLayer.json.skillListingMaxDescChars);
			const line = lineOf(settingsLayer.lineIndex, 'skillListingMaxDescChars');
			skillListingMaxDescChars = {
				value: Number.isFinite(raw) && raw > 0 ? raw : null,
				sourcePath: settingsLayer.path,
				sourceLine: line,
				sourceLink: vscodeLink(settingsLayer.path, line),
			};
		}
	}

	const claimedOverrideKeys = new Set();
	for (const skill of discovered) {
		const candidateKeys = skill.qualifiedName === skill.name ? [skill.name] : [skill.qualifiedName, skill.name];
		let matched = null;
		for (const key of candidateKeys) {
			if (overridesByKey.has(key)) {
				matched = overridesByKey.get(key);
				claimedOverrideKeys.add(key);
				break;
			}
		}
		if (matched) {
			skill.state = matched.value;
			skill.stateSource = matched.path;
			skill.stateLine = matched.line;
			skill.stateLink = matched.link;
		}
	}

	// Recompute listing cost now that each skill's final state (post-override)
	// and the resolved skillListingMaxDescChars cap are both known -- the
	// buildSkillEntry() figure above only ever assumed the un-overridden 'on'
	// state with no cap.
	for (const skill of discovered) {
		skill.listingChars = resolveListingChars(skill, skillListingMaxDescChars.value);
		skill.estimatedTokens = estimateTokens('x'.repeat(skill.listingChars));
	}

	const orphanOverrides = [];
	for (const [name, override] of overridesByKey.entries()) {
		if (claimedOverrideKeys.has(name)) continue;
		orphanOverrides.push({
			name,
			layer: override.layer,
			path: override.path,
			line: override.line,
			link: override.link,
		});
	}

	// Shadowing: only user/project scopes participate -- plugin skills are
	// namespaced by `<plugin>:` and never collide with a bare skill name.
	const byName = new Map();
	for (const skill of discovered) {
		if (skill.layer !== 'user' && skill.layer !== 'project') continue;
		if (!byName.has(skill.name)) byName.set(skill.name, []);
		byName.get(skill.name).push(skill);
	}

	const duplicates = [];
	for (const [name, group] of byName.entries()) {
		const layers = [...new Set(group.map((s) => s.layer))];
		if (layers.length < 2) continue;
		const winner = winningLayer(layers);
		for (const skill of group) {
			skill.shadowedBy = skill.layer === winner ? null : winner;
		}
		const contents = group.map((s) => readSourceFile(s.path).content);
		const identical = contents.every((c) => c === contents[0]);
		duplicates.push({ name, layers, identical });
	}

	const usage = readSkillUsage(home);
	const withUsage = discovered.map((skill) => attachUsage(skill, usage));

	return {
		skills: withUsage,
		duplicates,
		orphanOverrides,
		disableBundledSkills,
		skillListingMaxDescChars,
		usage: {
			available: usage.available,
			sourcePath: usage.sourcePath,
			error: usage.error,
			note: 'usageCount is a lifetime total since install, never windowed; lastUsedAt is the recency signal.',
		},
	};
}

export function skillListingTotals(skills) {
	const totals = { totalChars: 0, estimatedTokens: 0, countByLayer: {}, countByState: {} };
	for (const skill of skills ?? []) {
		if (!VISIBLE_STATES.has(skill.state)) continue;
		if (skill.shadowedBy != null) continue; // the model never sees the losing copy
		totals.totalChars += skill.listingChars;
		totals.estimatedTokens += skill.estimatedTokens;
		totals.countByLayer[skill.layer] = (totals.countByLayer[skill.layer] ?? 0) + 1;
		totals.countByState[skill.state] = (totals.countByState[skill.state] ?? 0) + 1;
	}
	return totals;
}

export { VALID_STATES };
