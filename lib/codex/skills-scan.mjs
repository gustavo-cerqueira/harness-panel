/**
 * Codex skill discovery.
 *
 * Codex counterpart of `../skills-scan.mjs`. Same row shape (name,
 * qualifiedName, layer, path, line, link, description, state, stateSource,
 * shadowedBy, listingChars, usageKnown, usageCount, lastUsedAt) so
 * public/app.js renders both harnesses through the same `skills` adapter,
 * plus two Codex-only fields: `isSymlink`/`symlinkTarget`, because a Codex
 * skill directory can itself be a symlink (a plugin-managed or shared skill
 * source), which the Claude scanner never has to handle.
 *
 * FIVE roots (2026-08-26 Codex-confirmed facts):
 *   <codexHome>/skills            'user'    deprecated compatibility root
 *   <codexHome>/skills/.system    'system'  bundled with the CLI itself
 *   <home>/.agents/skills         'user'    preferred user-installed root
 *   <projectRoot>/.agents/skills  'project' repo/team root (often reached
 *                                            through a directory symlink,
 *                                            e.g. .agents -> .claude; Node
 *                                            resolves that transparently, so
 *                                            no special-casing is needed here)
 *   <projectRoot>/.codex/skills   'project' adjacent to the project config layer
 *   plugin cache skills           'plugin'  qualifiedName `<plugin>:<name>`
 *
 * Only the project root itself is scanned for `.agents/skills` and
 * `.codex/skills` (not every directory from project root down to cwd) --
 * this mirrors how the rest of the panel treats nested, cwd-dependent
 * candidates as out of scope for a static inventory (see the memory-chain
 * scanner's treatment of nested AGENTS.md files).
 *
 * STATE: Codex disables one skill at a time with a `[[skills.config]]`
 * table in config.toml (`path = "<abs SKILL.md>"`, `enabled = false`). There
 * is no partial state like Claude's `name-only` / `user-invocable-only` --
 * a skill is either 'on' or 'off'. The disable list is read with a small
 * line-based scan of config.toml for `[[skills.config]]` blocks and their
 * `path` / `enabled` keys; this is a stopgap until `lib/codex/toml.mjs`
 * (a real TOML parser, in progress elsewhere) can replace it outright.
 *
 * SHADOWING: Codex does NOT collapse same-name skills across roots the way
 * Claude Code does -- both copies are injected into the catalog with their
 * own paths (confirmed: the live catalog carries duplicate OpenSpec skill
 * names from both `.agents/skills` and `.codex/skills`). So `shadowedBy` is
 * always null here, and every collision -- including collisions between two
 * roots that share the SAME layer id, e.g. project `.agents/skills` vs
 * project `.codex/skills` -- is reported instead through `duplicates`.
 * Deterministic precedence for an implicit same-name invocation is
 * UNVERIFIED, so the panel never guesses a winner.
 *
 * USAGE: Codex has no lifetime dispatch counter equivalent to Claude's
 * `skillUsage` in `~/.claude.json`. Every row carries `usageKnown: false`,
 * `usageCount: null`, `lastUsedAt: null` -- never a guessed zero.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, readSourceFile, vscodeLink } from '../source-file.mjs';
import { resolveCodexPaths } from './layers.mjs';

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

/** Hand-rolled frontmatter reader -- see `../skills-scan.mjs` for the identical algorithm. */
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
 * Directory entries under `dir`, dot-prefixed names excluded, following
 * symlinked entries whose target is itself a directory. `fs.readdirSync`
 * `Dirent.isDirectory()` is false for a symlink even when its target is a
 * directory (the dirent type is not resolved through the link), so a plain
 * `entry.isDirectory()` filter -- what the Claude scanner uses -- would
 * silently drop a symlinked skill. This resolves each symlink explicitly
 * instead.
 */
function listSkillDirs(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push({ name: entry.name, abs, isSymlink: false, symlinkTarget: null });
			continue;
		}
		if (!entry.isSymbolicLink()) continue;
		let target = null;
		let targetIsDir = false;
		try {
			target = fs.realpathSync(abs);
			targetIsDir = fs.statSync(abs).isDirectory();
		} catch {
			continue; // broken symlink -- not a usable skill dir
		}
		if (targetIsDir) out.push({ name: entry.name, abs, isSymlink: true, symlinkTarget: target });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Plain subdirectory names, no symlink-following -- used to walk the plugin cache tree. */
function listPlainDirs(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.sort();
}

function listPluginSkillDirs(cacheDir) {
	const out = [];
	for (const marketplace of listPlainDirs(cacheDir)) {
		const marketplaceDir = path.join(cacheDir, marketplace);
		for (const plugin of listPlainDirs(marketplaceDir)) {
			const pluginDir = path.join(marketplaceDir, plugin);
			for (const version of listPlainDirs(pluginDir)) {
				const skillsDir = path.join(pluginDir, version, 'skills');
				for (const dirInfo of listSkillDirs(skillsDir)) {
					out.push({ plugin, dirInfo });
				}
			}
		}
	}
	return out;
}

function buildSkillEntry({ dirInfo, layer, plugin }) {
	const skillPath = path.join(dirInfo.abs, 'SKILL.md');
	const file = readSourceFile(skillPath);
	const entry = {
		name: dirInfo.name,
		qualifiedName: plugin ? `${plugin}:${dirInfo.name}` : dirInfo.name,
		layer,
		plugin: plugin ?? null,
		path: skillPath,
		line: 1,
		link: vscodeLink(skillPath, 1),
		description: '',
		state: 'on',
		stateSource: null,
		stateLine: null,
		stateLink: null,
		shadowedBy: null,
		listingChars: dirInfo.name.length + 8,
		estimatedTokens: estimateTokens('x'.repeat(dirInfo.name.length + 8)),
		usageKnown: false,
		usageCount: null,
		lastUsedAt: null,
		isSymlink: dirInfo.isSymlink,
		symlinkTarget: dirInfo.symlinkTarget,
		error: file.error,
	};
	if (!file.readable || file.content == null) return entry;

	const attrs = parseFrontmatter(file.content);
	const nameAttr = attrs.get('name');
	const descAttr = attrs.get('description');
	const resolvedName = nameAttr?.value || dirInfo.name;
	const description = descAttr?.value ?? '';
	const listingChars = resolvedName.length + description.length + 8;

	entry.name = resolvedName;
	entry.qualifiedName = plugin ? `${plugin}:${resolvedName}` : resolvedName;
	entry.line = descAttr?.line ?? nameAttr?.line ?? 1;
	entry.link = vscodeLink(skillPath, entry.line);
	entry.description = description;
	entry.listingChars = listingChars;
	entry.estimatedTokens = estimateTokens('x'.repeat(listingChars));

	return entry;
}

/**
 * Line-based scan for `[[skills.config]]` blocks in one config.toml.
 *
 * Stopgap: `lib/codex/toml.mjs` (a real TOML parser) is being written
 * elsewhere in parallel and will replace this once it lands. Until then this
 * only understands the one shape the disable feature actually uses -- a
 * `[[skills.config]]` array-of-tables entry with flat `path = "..."` and
 * `enabled = true|false` keys -- and gives up cleanly (returns nothing for
 * that block) on anything fancier (multi-line strings, inline tables).
 */
function parseSkillsConfigDisables(configPath) {
	const disables = new Map(); // abs SKILL.md path -> { enabled, line, sourcePath }
	const file = readSourceFile(configPath);
	if (!file.readable || file.content == null) return disables;

	const lines = file.content.split('\n');
	let current = null;

	const closeCurrent = () => {
		if (current && current.path) {
			disables.set(current.path, { enabled: current.enabled, line: current.line, sourcePath: configPath });
		}
		current = null;
	};

	for (let i = 0; i < lines.length; i += 1) {
		const trimmed = lines[i].trim();
		if (/^\[\[skills\.config\]\]/.test(trimmed)) {
			closeCurrent();
			current = { path: null, enabled: true, line: null };
			continue;
		}
		if (/^\[/.test(trimmed)) {
			closeCurrent();
			continue;
		}
		if (!current) continue;

		const pathMatch = /^path\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(trimmed);
		if (pathMatch) {
			current.path = pathMatch[1].replace(/\\(.)/g, '$1');
			current.line = i + 1;
			continue;
		}
		const enabledMatch = /^enabled\s*=\s*(true|false)/.exec(trimmed);
		if (enabledMatch) current.enabled = enabledMatch[1] === 'true';
	}
	closeCurrent();
	return disables;
}

export function scanCodexSkills({ home, projectRoot }) {
	const paths = resolveCodexPaths({ home, projectRoot });

	const discovered = [];
	for (const dirInfo of listSkillDirs(paths.user.skillsDir)) {
		discovered.push(buildSkillEntry({ dirInfo, layer: 'user', plugin: null }));
	}
	for (const dirInfo of listSkillDirs(paths.user.systemSkillsDir)) {
		discovered.push(buildSkillEntry({ dirInfo, layer: 'system', plugin: null }));
	}
	for (const dirInfo of listSkillDirs(paths.user.agentsSkillsDir)) {
		discovered.push(buildSkillEntry({ dirInfo, layer: 'user', plugin: null }));
	}
	for (const dirInfo of listSkillDirs(paths.project.agentsSkillsDir)) {
		discovered.push(buildSkillEntry({ dirInfo, layer: 'project', plugin: null }));
	}
	for (const dirInfo of listSkillDirs(paths.project.skillsDir)) {
		discovered.push(buildSkillEntry({ dirInfo, layer: 'project', plugin: null }));
	}
	for (const { plugin, dirInfo } of listPluginSkillDirs(paths.plugin.cacheDir)) {
		discovered.push(buildSkillEntry({ dirInfo, layer: 'plugin', plugin }));
	}

	// Weakest-first: project config.toml disables win over user config.toml
	// disables for the same path, matching the rest of the panel's cascade
	// convention even though a real collision here would be unusual.
	const skillsConfigByPath = new Map();
	for (const configPath of [paths.user.config, paths.project.config]) {
		for (const [skillPath, entry] of parseSkillsConfigDisables(configPath)) {
			skillsConfigByPath.set(skillPath, entry);
		}
	}
	for (const skill of discovered) {
		const cfg = skillsConfigByPath.get(skill.path);
		if (!cfg || cfg.enabled !== false) continue;
		skill.state = 'off';
		skill.stateSource = cfg.sourcePath;
		skill.stateLine = cfg.line;
		skill.stateLink = vscodeLink(cfg.sourcePath, cfg.line);
	}

	// Duplicates: every root except the plugin cache participates, because
	// plugin skills are namespaced (`<plugin>:<name>`) and never collide with
	// a bare name. Codex does not collapse these -- both rows stay 'on' (or
	// whatever their own state resolves to) and `shadowedBy` stays null.
	const byName = new Map();
	for (const skill of discovered) {
		if (skill.layer === 'plugin') continue;
		if (!byName.has(skill.name)) byName.set(skill.name, []);
		byName.get(skill.name).push(skill);
	}
	const duplicates = [];
	for (const [name, group] of byName.entries()) {
		if (group.length < 2) continue;
		const layers = [...new Set(group.map((s) => s.layer))];
		const paths_ = group.map((s) => s.path);
		const contents = group.map((s) => readSourceFile(s.path).content);
		const identical = contents.every((c) => c === contents[0]);
		duplicates.push({ name, layers, paths: paths_, identical });
	}

	return {
		skills: discovered,
		duplicates,
		orphanOverrides: [],
		disableBundledSkills: null,
		usage: {
			available: false,
			sourcePath: null,
			error: null,
			note: 'Codex records no per-skill lifetime usage counter equivalent to skillUsage in ~/.claude.json; every row carries usageKnown:false.',
		},
	};
}

/**
 * Listing-cost totals. Unlike Claude's `skillListingTotals`, every 'on' row
 * counts -- there is no `shadowedBy` exclusion here, because a Codex
 * duplicate is not a dead copy: both entries are actually injected into the
 * catalog.
 */
export function codexSkillListingTotals(skills) {
	const totals = { totalChars: 0, estimatedTokens: 0, countByLayer: {}, countByState: {} };
	for (const skill of skills ?? []) {
		totals.countByState[skill.state] = (totals.countByState[skill.state] ?? 0) + 1;
		if (skill.state === 'off') continue;
		totals.totalChars += skill.listingChars;
		totals.estimatedTokens += skill.estimatedTokens;
		totals.countByLayer[skill.layer] = (totals.countByLayer[skill.layer] ?? 0) + 1;
	}
	return totals;
}
