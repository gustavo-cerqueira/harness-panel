/**
 * Subagent definition discovery.
 *
 * Agent Markdown files live at:
 *   user    -> <home>/.claude/agents/**\/*.md
 *   project -> <projectRoot>/.claude/agents/**\/*.md
 *   plugin  -> <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/agents/**\/*.md
 *
 * A file with no `name:` in frontmatter is a co-located doc (a README living
 * next to the real agents), not an agent -- it is skipped silently. A file
 * WITH a `name` but no `description` is a real finding: Claude Code refuses
 * to load such a file, so it is kept and flagged `valid: false`.
 *
 * `agentCollisions` exists because two files in the same directory can define
 * the same `name`; the loser is discarded silently and which one wins follows
 * unsorted `readdir` order -- exactly the kind of thing this panel exists to
 * surface.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, vscodeLink } from './source-file.mjs';
import { pickActiveVersion } from './plugins-scan.mjs';

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

/** Same hand-rolled frontmatter reader as skills-scan.mjs -- see there for the rationale. */
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

/** Parses a `tools:` frontmatter entry (comma string, YAML list, or flow list) into an array. */
function parseTools(entry) {
	if (!entry) return [];
	if (entry.continuationLines.length > 0 && entry.continuationLines.every((line) => line.startsWith('-'))) {
		return entry.continuationLines
			.map((line) => stripQuotes(line.replace(/^-[ \t]*/, '').trim()))
			.filter((item) => item.length > 0);
	}
	const inline = entry.value ?? '';
	if (inline.length === 0) return [];
	const cleaned = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline;
	return cleaned
		.split(',')
		.map((item) => stripQuotes(item.trim()))
		.filter((item) => item.length > 0);
}

function listSubdirs(dir) {
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

/** Recursively finds every non-hidden `*.md` file under `rootDir`. Absent/unreadable dirs yield []. */
function walkMarkdownFiles(rootDir) {
	const results = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				results.push(full);
			}
		}
	}
	return results.sort();
}

/**
 * Every plugin agent file on disk, each tagged with the cached version it came
 * from and whether that version is the one a session would actually load.
 *
 * All versions are walked on purpose: this scanner reports what is on disk, and
 * a plugin with five cached versions really does carry five copies of each
 * agent file. But only one of them can ever load, so each row says which it is
 * — using `pickActiveVersion` from plugins-scan, the same rule that picks the
 * version shown in the Plugins section, never a second rule that could drift.
 */
function listPluginAgentFiles(cacheDir) {
	const files = [];
	for (const marketplace of listSubdirs(cacheDir)) {
		const marketplaceDir = path.join(cacheDir, marketplace);
		for (const plugin of listSubdirs(marketplaceDir)) {
			const pluginDir = path.join(marketplaceDir, plugin);
			const versions = listSubdirs(pluginDir);
			const active = pickActiveVersion(versions, pluginDir) ?? [...versions].sort().at(-1) ?? null;
			for (const version of versions) {
				const agentsDir = path.join(pluginDir, version, 'agents');
				for (const agentPath of walkMarkdownFiles(agentsDir)) {
					files.push({ plugin, agentPath, pluginVersion: version, activeVersion: version === active });
				}
			}
		}
	}
	return files;
}

function buildAgentEntry({ layer, plugin, agentPath, pluginVersion = null, activeVersion = null }) {
	const file = readSourceFile(agentPath);

	if (!file.readable || file.content == null) {
		// The file exists (readdir found it) but can't be read -- a real error,
		// not a co-located doc. We cannot know whether it would have had a
		// `name`, so it is surfaced rather than silently dropped.
		return {
			name: null,
			layer,
			plugin: plugin ?? null,
			// null on a user/project row: those are not version-scoped, so calling
			// one an "active version" would be an answer to a question that does
			// not apply to it.
			pluginVersion,
			activeVersion,
			path: agentPath,
			line: 1,
			link: vscodeLink(agentPath, 1),
			description: null,
			model: null,
			tools: [],
			bytes: null,
			valid: false,
			invalidReason: 'unreadable',
			error: file.error,
		};
	}

	const attrs = parseFrontmatter(file.content);
	const nameAttr = attrs.get('name');
	if (!nameAttr || nameAttr.value.length === 0) return null; // co-located doc, not an agent

	const descAttr = attrs.get('description');
	const modelAttr = attrs.get('model');
	const toolsAttr = attrs.get('tools');

	const hasDescription = Boolean(descAttr && descAttr.value.length > 0);
	const line = nameAttr.line;

	return {
		name: nameAttr.value,
		layer,
		plugin: plugin ?? null,
		pluginVersion,
		activeVersion,
		path: agentPath,
		line,
		link: vscodeLink(agentPath, line),
		description: hasDescription ? descAttr.value : null,
		model: modelAttr?.value || null,
		tools: parseTools(toolsAttr),
		bytes: file.size,
		valid: hasDescription,
		invalidReason: hasDescription ? null : 'missing description -- this agent file will not load',
		error: null,
	};
}

export function scanAgents({ home, projectRoot }) {
	const userAgentsDir = path.join(home, '.claude', 'agents');
	const projectAgentsDir = path.join(projectRoot, '.claude', 'agents');
	const pluginCacheDir = path.join(home, '.claude', 'plugins', 'cache');

	const agents = [];
	for (const agentPath of walkMarkdownFiles(userAgentsDir)) {
		const entry = buildAgentEntry({ layer: 'user', plugin: null, agentPath });
		if (entry) agents.push(entry);
	}
	for (const agentPath of walkMarkdownFiles(projectAgentsDir)) {
		const entry = buildAgentEntry({ layer: 'project', plugin: null, agentPath });
		if (entry) agents.push(entry);
	}
	for (const { plugin, agentPath, pluginVersion, activeVersion } of listPluginAgentFiles(pluginCacheDir)) {
		const entry = buildAgentEntry({ layer: 'plugin', plugin, agentPath, pluginVersion, activeVersion });
		if (entry) agents.push(entry);
	}

	return agents;
}

export function agentCollisions(agents) {
	const groups = new Map();
	for (const agent of agents ?? []) {
		if (!agent || agent.name == null) continue;
		const dir = path.dirname(agent.path);
		const key = `${dir} ${agent.name}`;
		if (!groups.has(key))
			groups.set(key, { name: agent.name, dir, layer: agent.layer, plugin: agent.plugin, agents: [] });
		groups.get(key).agents.push(agent);
	}
	return [...groups.values()].filter((group) => group.agents.length > 1);
}
