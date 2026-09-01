/**
 * Codex counterpart of `../agents-scan.mjs`: custom-agent definition discovery.
 *
 * Agent TOML files live at:
 *   user    -> <codexHome>/agents/*.toml
 *   project -> <projectRoot>/.codex/agents/*.toml
 *
 * Required schema fields are `name`, `description`, `developer_instructions`;
 * the `name` FIELD (not the filename) is the identity, exactly like Claude's
 * frontmatter `name:`. Unlike Claude Code's agent Markdown files, every
 * `.toml` file under an agents directory is presumed to BE an agent
 * definition -- there is no "co-located doc" convention to skip here, so a
 * file missing `name` is still surfaced as a row (`valid: false`), never
 * dropped silently.
 *
 * NO TOOL ALLOWLIST: Codex agent files carry no `tools:` field the way
 * Claude's frontmatter does -- every custom agent gets the full toolset of
 * its sandbox/approval configuration. `tools` is always `[]` here for row-
 * shape parity with the Claude adapter, not because Codex withholds tools.
 *
 * BUILT-INS: `default`, `worker`, `explorer` are compiled into the CLI
 * (2026-08-26, Codex CLI 0.149.1) and are emitted as `layer: 'builtin'` rows
 * with no file to link to. A custom agent sharing a built-in's name
 * overrides it; the built-in row's `overriddenBy` records which custom
 * file(s) do so.
 *
 * SAME-NAME COLLISION ACROSS user/project IS UNVERIFIED: unlike a shadowed
 * Claude skill (project always wins, documented), Codex's precedence between
 * a user-scope and project-scope agent sharing one `name` has not been
 * confirmed against Codex's own source. Both rows are always kept --
 * `agentCollisions()` groups them for the panel to flag, but this module
 * makes no claim about which one Codex would actually load.
 *
 * READ ONLY: fs.readdirSync plus the shared readSourceFile primitive only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, vscodeLink } from '../source-file.mjs';
import { parseToml, lineOfTomlKey } from './toml.mjs';
import { resolveCodexPaths } from './layers.mjs';

const BUILTIN_NAMES = ['default', 'worker', 'explorer'];
const BUILTIN_DESCRIPTION = 'Built into Codex CLI 0.149.1';

function listAgentTomlFiles(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isFile() && e.name.endsWith('.toml'))
		.map((e) => path.join(dir, e.name))
		.sort();
}

function buildAgentRow(filePath, layer) {
	const file = readSourceFile(filePath);
	if (!file.readable || file.content == null) {
		return {
			name: null,
			layer,
			path: filePath,
			line: 1,
			link: vscodeLink(filePath, 1),
			valid: false,
			invalidReason: 'unreadable',
			tools: [],
			model: null,
			description: null,
			reasoningEffort: null,
			sandboxMode: null,
			developerInstructionsChars: null,
			mcpServersOverride: [],
			skillsConfig: null,
			bytes: null,
			error: file.error,
			overriddenBy: null,
		};
	}

	const { value, locations, errors } = parseToml(file.content);
	const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : null;
	const description = typeof value.description === 'string' && value.description.length > 0 ? value.description : null;
	const developerInstructions = typeof value.developer_instructions === 'string' ? value.developer_instructions : null;
	const line = lineOfTomlKey(locations, ['name']) ?? 1;

	const missing = [];
	if (!name) missing.push('name');
	if (!description) missing.push('description');
	if (!developerInstructions) missing.push('developer_instructions');
	const valid = missing.length === 0;

	const mcpServersOverride =
		value.mcp_servers && typeof value.mcp_servers === 'object' ? Object.keys(value.mcp_servers) : [];

	return {
		name,
		layer,
		path: filePath,
		line,
		link: vscodeLink(filePath, line),
		valid,
		invalidReason: valid ? null : `missing ${missing.join(', ')} -- this agent file will not load`,
		tools: [],
		model: typeof value.model === 'string' ? value.model : null,
		description,
		reasoningEffort: typeof value.model_reasoning_effort === 'string' ? value.model_reasoning_effort : null,
		sandboxMode: typeof value.sandbox_mode === 'string' ? value.sandbox_mode : null,
		developerInstructionsChars: developerInstructions ? developerInstructions.length : null,
		mcpServersOverride,
		skillsConfig: Object.hasOwn(value, 'skills') ? value.skills : null,
		bytes: file.size,
		error: errors.length > 0 ? `${errors.length} TOML parse error(s)` : null,
		overriddenBy: null,
	};
}

function buildBuiltinRow(name) {
	return {
		name,
		layer: 'builtin',
		path: null,
		line: null,
		link: null,
		valid: true,
		invalidReason: null,
		tools: [],
		model: null,
		description: BUILTIN_DESCRIPTION,
		reasoningEffort: null,
		sandboxMode: null,
		developerInstructionsChars: null,
		mcpServersOverride: [],
		skillsConfig: null,
		bytes: null,
		error: null,
		overriddenBy: null,
	};
}

/**
 * @param {{home: string, projectRoot: string}} options
 * @returns {object[]} same top-level shape as `../agents-scan.mjs`'s `scanAgents()`: a plain array of rows.
 */
export function scanCodexAgents({ home, projectRoot }) {
	const paths = resolveCodexPaths({ home, projectRoot });

	const agents = [];
	for (const filePath of listAgentTomlFiles(paths.user.agentsDir)) agents.push(buildAgentRow(filePath, 'user'));
	for (const filePath of listAgentTomlFiles(paths.project.agentsDir)) agents.push(buildAgentRow(filePath, 'project'));

	const builtins = BUILTIN_NAMES.map(buildBuiltinRow);
	for (const builtin of builtins) {
		const overriders = agents.filter((a) => a.name === builtin.name);
		if (overriders.length > 0) builtin.overriddenBy = overriders.map((a) => ({ layer: a.layer, path: a.path }));
	}

	return [...agents, ...builtins];
}

/**
 * Groups non-builtin agent rows sharing one `name` across layers (a
 * user/project collision). See module header: which one Codex actually
 * loads is UNVERIFIED, so this is a reporting helper, not a precedence
 * resolver -- `scanCodexAgents()` always keeps both rows regardless.
 */
export function agentCollisions(agents) {
	const groups = new Map();
	for (const agent of agents ?? []) {
		if (!agent || agent.name == null || agent.layer === 'builtin') continue;
		if (!groups.has(agent.name)) groups.set(agent.name, { name: agent.name, agents: [] });
		groups.get(agent.name).agents.push(agent);
	}
	return [...groups.values()].filter((group) => group.agents.length > 1);
}
