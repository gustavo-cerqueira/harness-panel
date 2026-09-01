/**
 * Harness Control Panel — zero-dependency Node (>=22) HTTP server.
 *
 *   node server.mjs
 *
 * Inventories every Claude Code harness component that applies to this
 * workspace, from the enterprise layer down to the worktree layer, and hands
 * each row back with a `vscode://file/<abs>:<line>` deep link.
 *
 * READ-ONLY BY CONSTRUCTION. This file and everything under lib/ contain no
 * write call of any kind: no fs.writeFile, appendFile, rm, rename, mkdir, or
 * createWriteStream. The only HTTP verb with a route is GET; every other method
 * gets 405 before any handler runs. The panel's whole value is that it tells
 * you the truth about your config, so it must never be able to change it.
 *
 * Endpoints:
 *   GET /                    the panel UI (public/)
 *   GET /api/state           full inventory, every section
 *   GET /api/section/<name>  one section, for cheap refreshes
 *   GET /api/hook-script     body of one configured hook script (allowlisted)
 *   GET /api/roots           git worktrees this panel may read
 *   GET /api/file            one inventoried file, for the in-panel preview
 *   GET /api/events          SSE stream, pushes `update` when a config changes
 *
 * TWO HARNESSES, ONE SERVER. `?harness=claude|codex` selects WHOSE configuration
 * is inventoried; it is accepted on /api/state, /api/section/<id>, /api/file and
 * /api/hook-script. Missing means `claude`, the panel's original subject. An
 * unknown id is a 400, never a silent fallback: answering a Codex question with
 * Claude's inventory would be the panel lying about whose harness you are
 * reading, which is the one failure it exists to prevent.
 *
 * Binds 127.0.0.1 only. Idempotent start: an occupied port logs and exits 0 so
 * a VSCode folderOpen task never fails.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTaxonomy, clusterCatalog, emptyClusters, isClusteredKind, reportsGaps } from './lib/taxonomy.mjs';
import { readCuration } from './lib/curation.mjs';

/**
 * Reads a HARNESS_* setting, accepting the legacy EZ_HARNESS_* name.
 *
 * The prefix carried one workspace's initials and lost them when this panel was
 * published on its own. Existing launchers still export the old names; silently
 * ignoring them would have looked like the setting stopped working.
 */
const envSetting = (name) => process.env[`HARNESS_${name}`] ?? process.env[`EZ_HARNESS_${name}`] ?? null;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const LIB_DIR = path.join(HERE, 'lib');

export const DEFAULT_PORT = 4546;
const STATE_CACHE_MS = 1500;
const USAGE_CACHE_MS = 5 * 60_000;
const WATCH_DEBOUNCE_MS = 400;
const SSE_HEARTBEAT_MS = 25_000;
const MAX_PREVIEW_CHARS = 400_000;
/** Object keys whose string value is an absolute path a row linked to. */
const PATH_KEYS = new Set([
	'path',
	'sourcePath',
	'scriptPath',
	'settingsPath',
	'transcriptPath',
	'stateSource',
	'modulePath',
]);

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.json': 'application/json; charset=utf-8',
};

/**
 * Section registry. Each entry names its module and the export that builds it.
 * Modules are imported lazily and independently so one broken or not-yet-built
 * scanner degrades to an error row instead of taking the whole panel down.
 */
const SECTIONS = [
	{ id: 'memory', label: 'Memory / instructions', module: 'memory-chain.mjs', fn: 'scanMemoryChain' },
	{ id: 'settings', label: 'Settings', module: 'settings-merge.mjs', fn: 'mergeSettings' },
	{ id: 'hooks', label: 'Hooks', module: 'hooks-scan.mjs', fn: 'scanHooks' },
	{ id: 'skills', label: 'Skills', module: 'skills-scan.mjs', fn: 'scanSkills' },
	{ id: 'commands', label: 'Slash commands', module: 'commands-scan.mjs', fn: 'scanCommands' },
	{ id: 'agents', label: 'Subagents', module: 'agents-scan.mjs', fn: 'scanAgents' },
	{ id: 'mcp', label: 'MCP servers', module: 'mcp-scan.mjs', fn: 'scanMcpServers' },
	{ id: 'directives', label: 'Directives', module: 'directives-scan.mjs', fn: 'scanDirectives' },
	{ id: 'rules', label: 'Rules', module: 'rules-scan.mjs', fn: 'scanRules' },
	{ id: 'plugins', label: 'Plugins', module: 'plugins-scan.mjs', fn: 'scanPlugins' },
	{ id: 'worktrees', label: 'Worktree drift', module: 'worktree-drift.mjs', fn: 'scanWorktreeDrift' },
	{ id: 'injected', label: 'Injected context', module: 'injected-context.mjs', fn: 'scanInjectedContext' },
];

/**
 * The same inventory, for the OTHER harness on this machine.
 *
 * Codex CLI reads a different tree entirely — `~/.codex`, `~/.agents` and
 * `<repo>/.codex` — so every section needs its own scanner even where the
 * question ("which instruction files load?") is identical. The section IDS are
 * deliberately shared with the Claude registry: public/app.js keys its renderers
 * by id, so a Codex scanner that emits the same row shape is rendered by the
 * same adapter, with no second UI to keep in sync.
 *
 * Two entries have no Claude counterpart. `execpolicy` is Codex's sandbox rule
 * language (`~/.codex/rules/*.rules`), which Claude Code has nothing like, and
 * the labels differ where the vocabulary differs — Codex has "custom prompts",
 * not slash commands, and its trust model is per-project, not per-worktree drift.
 *
 * A scanner that throws still degrades to the honest error row runSection()
 * produces, which is the whole point of importing scanners lazily and
 * independently.
 */
const CODEX_SECTIONS = [
	{
		id: 'memory',
		label: 'Instructions (AGENTS.md chain)',
		module: 'codex/memory-chain.mjs',
		fn: 'scanCodexMemoryChain',
	},
	{ id: 'settings', label: 'Config (config.toml)', module: 'codex/settings-merge.mjs', fn: 'mergeCodexSettings' },
	{ id: 'hooks', label: 'Hooks', module: 'codex/hooks-scan.mjs', fn: 'scanCodexHooks' },
	{ id: 'skills', label: 'Skills', module: 'codex/skills-scan.mjs', fn: 'scanCodexSkills' },
	{ id: 'commands', label: 'Commands & custom prompts', module: 'codex/prompts-scan.mjs', fn: 'scanCodexPrompts' },
	{ id: 'agents', label: 'Custom agents', module: 'codex/agents-scan.mjs', fn: 'scanCodexAgents' },
	{ id: 'mcp', label: 'MCP servers', module: 'codex/mcp-scan.mjs', fn: 'scanCodexMcpServers' },
	{ id: 'directives', label: 'Directives', module: 'codex/directives-scan.mjs', fn: 'scanCodexDirectives' },
	{ id: 'rules', label: 'Rules', module: 'codex/rules-scan.mjs', fn: 'scanCodexRules' },
	{ id: 'execpolicy', label: 'Exec policy', module: 'codex/execpolicy-scan.mjs', fn: 'scanExecPolicy' },
	{ id: 'plugins', label: 'Plugins', module: 'codex/plugins-scan.mjs', fn: 'scanCodexPlugins' },
	{ id: 'worktrees', label: 'Worktree trust', module: 'codex/worktree-trust.mjs', fn: 'scanWorktreeTrust' },
	{ id: 'injected', label: 'Injected context', module: 'codex/injected-context.mjs', fn: 'scanCodexInjectedContext' },
];

/** Where Codex keeps its per-machine configuration. */
function codexHomeDir(home) {
	return process.env.CODEX_HOME || path.join(home, '.codex');
}

/**
 * The harness registry: WHOSE configuration a request is about.
 *
 * Everything that differs between the two harnesses is an entry here rather than
 * a branch in the request handlers — the section list, the usage scanner, the
 * files worth watching, and what the panel is willing to claim about the base
 * system prompt. Adding a third harness is a third entry, not a third code path.
 *
 * `watchTargets` is a function because home and projectRoot are per-instance,
 * and CODEX_HOME can move the whole Codex tree.
 */
const HARNESSES = {
	claude: {
		id: 'claude',
		label: 'Claude Code',
		sections: SECTIONS,
		usageModule: 'usage-scan.mjs',
		baseSystemPrompt: 'Not exposed by the harness — internal to Claude Code and not readable from disk.',
		watchTargets: ({ home, projectRoot }) => [
			path.join(home, '.claude', 'CLAUDE.md'),
			path.join(home, '.claude', 'settings.json'),
			path.join(home, '.claude.json'),
			path.join(projectRoot, '.claude', 'CLAUDE.md'),
			path.join(projectRoot, '.claude', 'settings.json'),
			path.join(projectRoot, '.claude', 'settings.local.json'),
			path.join(projectRoot, '.mcp.json'),
		],
	},
	codex: {
		id: 'codex',
		label: 'Codex CLI',
		sections: CODEX_SECTIONS,
		usageModule: 'codex/usage-scan.mjs',
		// Same honesty as the Claude side, different reason: Codex assembles its
		// system prompt inside the CLI binary, so the panel can only report the
		// part that exists on disk and must not imply it knows the rest.
		baseSystemPrompt:
			'Not exposed by the harness — Codex builds its system prompt in the CLI binary; only the instructions it injects from disk (AGENTS.md chain) are readable.',
		watchTargets: ({ home, projectRoot }) => [
			path.join(codexHomeDir(home), 'config.toml'),
			path.join(codexHomeDir(home), 'AGENTS.md'),
			path.join(codexHomeDir(home), 'hooks.json'),
			path.join(projectRoot, 'AGENTS.md'),
			path.join(projectRoot, '.codex', 'hooks.json'),
			path.join(projectRoot, '.codex', 'config.toml'),
		],
	},
};

/** The harness a request lands on when it does not say. */
export const DEFAULT_HARNESS = 'claude';

/** Every harness this panel can inventory, in display order. */
export function harnessIds() {
	return Object.keys(HARNESSES);
}

/** Section ids of one harness. Unknown harness -> empty list, never a throw. */
export function sectionIds(harness = DEFAULT_HARNESS) {
	return (HARNESSES[harness]?.sections ?? []).map((section) => section.id);
}

/** Config files whose change should push an SSE update, for one harness. */
export function harnessWatchTargets(harness, { home, projectRoot }) {
	const entry = HARNESSES[harness];
	if (!entry) return [];
	return entry.watchTargets({ home, projectRoot });
}

/**
 * Resolves `?harness=`. Missing means Claude. An unknown id is refused rather
 * than coerced: silently answering with the other harness's inventory would be
 * the panel misreporting whose machine reality you are looking at.
 */
function resolveHarness(requested) {
	if (!requested) return { ok: true, id: DEFAULT_HARNESS };
	if (!Object.hasOwn(HARNESSES, requested)) return { ok: false, id: null, requested };
	return { ok: true, id: requested };
}

/**
 * Hook events that block the agent loop while they run, so their latency is
 * spent on every matching tool call or prompt. Mirrors the same list in
 * lib/usage-scan.mjs, and is only a fallback: a usage bucket that carries its
 * own `blocking` flag is believed over this.
 */
const BLOCKING_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit']);

/**
 * A slash command is written `/name` in a transcript and `name` on disk, so
 * the two sides only ever join with the slash removed. Without this the
 * commands section reported 0 invocations for every command on the machine.
 */
function commandKey(name) {
	return String(name ?? '').replace(/^\//, '');
}

/**
 * The tool names one hook row's matcher admits, or `null` when it admits
 * everything. Claude Code matchers are `|`-separated tool names; an absent,
 * empty or `*` matcher fires on every tool.
 */
function matcherTools(matcher) {
	if (typeof matcher !== 'string') return null;
	const tokens = matcher
		.split('|')
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0 || tokens.includes('*')) return null;
	return new Set(tokens);
}

/**
 * The tool whose calls a usage bucket counted. `lib/usage-scan.mjs` keys hook
 * runs by (hookEvent, hookName), and hookName carries the trigger as an
 * `Event:Tool` suffix (`PostToolUse:Bash`). A bucket named after the bare
 * event (`Stop`, `UserPromptSubmit`) has no tool: it fired on the event.
 */
function bucketTool(entry) {
	const name = String(entry?.hookName ?? '');
	const event = String(entry?.hookEvent ?? '');
	if (name.length === 0 || name === event) return null;
	if (event.length > 0 && name.startsWith(`${event}:`)) return name.slice(event.length + 1) || null;
	const colon = name.indexOf(':');
	return colon === -1 ? null : name.slice(colon + 1) || null;
}

function medianOf(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pools several usage buckets into one row's timing.
 *
 * The median is recomputed from the raw durations rather than averaged out of
 * the per-bucket medians, which would be a statistic of a statistic. A bucket
 * that carries no `durations` array (a harness whose usage scanner reports
 * summaries only) cannot be pooled: with exactly one such bucket its own p50
 * is exact and is kept, and with several the panel reports no median rather
 * than inventing one.
 */
function poolBuckets(matched) {
	const runs = matched.reduce((sum, entry) => sum + (entry.runs ?? 0), 0);
	const durations = matched.flatMap((entry) => (Array.isArray(entry.durations) ? entry.durations : []));
	const maxima = matched.map((entry) => entry.maxMs).filter((value) => typeof value === 'number');
	let p50Ms = null;
	if (durations.length > 0) p50Ms = medianOf(durations);
	else if (matched.length === 1) p50Ms = matched[0].p50Ms ?? null;
	return {
		runs,
		p50Ms,
		maxMs: maxima.length > 0 ? Math.max(...maxima) : null,
		timedOut: matched.reduce((sum, entry) => sum + (entry.timedOut ?? 0), 0),
	};
}

/**
 * Attaches transcript-derived counters to the rows the scanners read off disk.
 *
 * Exported and pure so the JOIN can be tested without booting a server: every
 * defect this function has had lived in the join, not in either side of it —
 * commands that never matched because of a leading slash, hook rows wearing a
 * sibling matcher's latency, MCP servers whose calls were dropped because they
 * have no config file to hang off. Mutates `sections` in place; that structure
 * is the per-request in-memory state object, never anything on disk.
 */
export function mergeUsage(sections, usage) {
	if (!usage || usage.error) return;
	const index = (list, key) => new Map((list ?? []).map((item) => [item[key], item]));

	// A harness that cannot record a dimension gets `null`, never `0`. Claude
	// mines every one of these from its transcripts, so nothing changes there;
	// Codex rollouts keep no custom-prompt or hook-execution record, and its
	// notes say so -- filling those rows with zeros would make the panel
	// contradict its own note and read as "ran zero times".
	const unknown = new Set([...(usage.untracked ?? []), ...(usage.partial ?? [])]);
	const count = (dimension, hit) => hit ?? null ?? (unknown.has(dimension) ? null : 0);

	const mcpBy = index(usage.mcpServers, 'name');
	if (sections.mcp?.ok) {
		const servers = Array.isArray(sections.mcp.data) ? sections.mcp.data : (sections.mcp.data?.servers ?? []);
		const joined = new Set();
		for (const server of servers) {
			// Transcripts record the NORMALIZED name, which is what tool calls and
			// permission rules match on — not the configured one.
			const hit = mcpBy.get(server.normalizedName) ?? mcpBy.get(server.name);
			server.calls = count('mcpServers', hit?.calls);
			server.toolCalls = hit?.tools ?? [];
			if (hit) joined.add(hit.name);
		}
		// A server the transcripts name and no config file defines is NOT part of
		// this workspace's harness, and listing it as one is how an app uninstalled
		// days ago kept showing up as an MCP server. It does not become a row.
		//
		// Nor is it silently dropped: the calls happened. And the panel cannot tell
		// whether such a server still exists — nothing on disk records which
		// connectors a session can currently reach (`claudeAiMcpEverConnected` is
		// empty here, and a transcript records calls, not availability). So this is
		// reported as what it is: past traffic, with the window it came from and an
		// explicit statement that current reachability is not knowable from disk.
		const seenOnly = (usage.mcpServers ?? []).filter((item) => !joined.has(item.name) && item.calls);
		if (seenOnly.length && sections.mcp.data && !Array.isArray(sections.mcp.data)) {
			const window = usage.scanned?.oldest
				? ` (${String(usage.scanned.oldest).slice(0, 10)} to ${String(usage.scanned.newest ?? '').slice(0, 10)})`
				: '';
			sections.mcp.data.notes = [
				...(sections.mcp.data.notes ?? []),
				`${seenOnly.length} MCP server(s) were called in the scanned sessions${window} but no config file in any scanned scope defines them: ${seenOnly
					.map((item) => `${item.name} (${item.calls} call${item.calls === 1 ? '' : 's'})`)
					.join(
						', ',
					)}. They are not listed above because they are not part of this workspace's configuration — they either reached those sessions from outside it (a claude.ai connector, the browser extension, the IDE bridge) or have since been removed. Nothing on disk records which connectors a session can reach today; run /mcp for the live list.`,
			];
		}
	}

	const cmdBy = new Map((usage.commands ?? []).map((item) => [commandKey(item.name), item]));
	if (sections.commands?.ok) {
		const commands = Array.isArray(sections.commands.data)
			? sections.commands.data
			: (sections.commands.data?.commands ?? []);
		for (const command of commands)
			command.invocations = count('commands', cmdBy.get(commandKey(command.name))?.invocations);
	}

	const agentBy = new Map((usage.subagents ?? []).map((item) => [item.type, item]));
	if (sections.agents?.ok) {
		const agents = Array.isArray(sections.agents.data) ? sections.agents.data : (sections.agents.data?.agents ?? []);
		for (const agent of agents) agent.dispatches = count('subagents', agentBy.get(agent.name)?.dispatches);
		// The most-dispatched types (general-purpose, Explore) are built into the
		// CLI and have no definition file, so they have no row to attach a count
		// to. Dropping them would hide the busiest subagents in the workspace.
		const defined = new Set(agents.map((agent) => agent.name));
		for (const item of usage.subagents ?? []) {
			if (defined.has(item.type) || !item.dispatches) continue;
			agents.push({
				name: item.type,
				layer: 'builtin',
				dispatches: item.dispatches,
				description: 'Built into Claude Code — dispatched by type, with no definition file in this workspace.',
				path: null,
				line: null,
				link: null,
				valid: true,
				tools: [],
				model: null,
			});
		}
	}

	if (sections.hooks?.ok) {
		const rows = Array.isArray(sections.hooks.data) ? sections.hooks.data : (sections.hooks.data?.hooks ?? []);
		// Buckets are keyed by (event, TOOL), not by event alone. Stamping the
		// busiest bucket of an event onto every row of that event made two
		// Edit/Write hooks wear the Bash hook's 1936 runs — numbers their matcher
		// could not have produced. A row may only claim a bucket whose tool its
		// own matcher admits.
		const bucketsByEvent = new Map();
		for (const entry of usage.hooks ?? []) {
			const list = bucketsByEvent.get(entry.hookEvent) ?? [];
			list.push({ ...entry, tool: bucketTool(entry) });
			bucketsByEvent.set(entry.hookEvent, list);
		}

		const matchedByRow = new Map();
		for (const row of rows) {
			const buckets = bucketsByEvent.get(row.event) ?? [];
			const tools = matcherTools(row.matcher);
			// A tool-less bucket is the event firing on itself; only a row that
			// admits every tool can own it.
			const matched = buckets.filter((bucket) =>
				tools === null ? true : bucket.tool !== null && tools.has(bucket.tool),
			);
			matchedByRow.set(row, matched);
		}

		for (const row of rows) {
			const buckets = bucketsByEvent.get(row.event) ?? [];
			const matched = matchedByRow.get(row) ?? [];
			row.blocking = matched[0]?.blocking ?? BLOCKING_HOOK_EVENTS.has(row.event);

			if (matched.length === 0) {
				row.runs = null;
				row.p50Ms = null;
				row.maxMs = null;
				row.timedOut = 0;
				row.sharedWith = 0;
				row.timingScope = 'no runs recorded for this matcher';
				continue;
			}

			Object.assign(row, poolBuckets(matched));

			// Two rows share a number when they claim any bucket in common — that
			// is the honest sense in which a total is "shared", and it is what the
			// label has to say so a reader never reads one row's total as its own
			// private cost.
			const mine = new Set(matched.map((bucket) => bucket.hookName));
			const sharedWith = rows.filter((other) =>
				(matchedByRow.get(other) ?? []).some((bucket) => mine.has(bucket.hookName)),
			).length;
			row.sharedWith = sharedWith;

			const others = sharedWith - 1;
			const shared = others > 0 ? `, shared with ${others} other hook${others === 1 ? '' : 's'} on ${row.event}` : '';
			row.timingScope =
				matched.length === buckets.length
					? `event total — every ${row.event} run recorded${shared}`
					: `matcher ${row.matcher} only${shared}`;
		}
	}
}

export function createPanelServer({ home = os.homedir(), projectRoot = process.cwd(), log = () => {} } = {}) {
	// Stamped once at boot. Shown in the header so a browser tab left open
	// against an older instance identifies itself instead of quietly serving
	// stale behaviour — which is exactly how an alphabetically-sorted skills
	// list got mistaken for a broken sort.
	const startedAt = new Date().toISOString();
	let boundPort = null;

	// Optional build stamp written by the ezharness launcher next to this file.
	// Comparing it against what the launcher is about to install is the only
	// reliable staleness check: `git archive` preserves original mtimes, so file
	// times say nothing, and boot time is UTC while file times are local.
	const buildStamp = (() => {
		try {
			return fs.readFileSync(path.join(HERE, '.build'), 'utf8').trim() || null;
		} catch {
			return null;
		}
	})();
	const sseClients = new Set();
	const watchers = new Map();
	// Keyed by `${harness}:${root}`, not by root alone: the same working tree has
	// one reality per harness, and serving Claude's cached state for a Codex
	// request would be the panel answering the wrong question convincingly.
	const cache = new Map(); // `${harness}:${root}` -> { at, state }
	const usageCache = new Map(); // `${harness}:${root}` -> { at, usage }
	let rootsCache = { at: 0, data: null };
	const ROOTS_TTL_MS = 30_000;

	/**
	 * Roots the panel is allowed to read.
	 *
	 * A root selector that accepted any path would turn this endpoint into an
	 * arbitrary filesystem reader. Only the git worktrees of THIS repo qualify,
	 * re-derived from git rather than from anything the client sends.
	 */
	/**
	 * Roots the panel is allowed to read.
	 *
	 * Discovery is delegated to lib/workspace-roots.mjs, which walks the
	 * configured workspace bases (default <home>/projects, overridable with
	 * HARNESS_WORKSPACE_ROOTS) and expands each git repo into its worktrees.
	 *
	 * The allowlist is the security boundary for `?root=`: without it the
	 * endpoint would be an arbitrary filesystem reader. It is re-derived from
	 * disk, never from the request, and every candidate is realpath-resolved so
	 * a symlink under a base cannot point outside it.
	 */
	async function discovery() {
		const now = Date.now();
		if (rootsCache.data && now - rootsCache.at < ROOTS_TTL_MS) return rootsCache.data;
		let data = { bases: [], roots: [{ path: projectRoot, name: path.basename(projectRoot) }], error: null };
		try {
			const mod = await import(`file://${path.join(LIB_DIR, 'workspace-roots.mjs')}`);
			const bases = (envSetting('WORKSPACE_ROOTS') || '')
				.split(':')
				.map((entry) => entry.trim())
				.filter(Boolean);
			data = mod.discoverWorkspaceRoots({
				home,
				bases: bases.length ? bases : undefined,
				extraRoots: [projectRoot],
			});
			data.isAllowedRoot = mod.isAllowedRoot;
			// Narrow the discovery to things that are actually projects. A hidden
			// directory (~/projects/.claude) and the workspace base itself are
			// readable directories but not workspaces, and listing them is noise.
			// Narrowing the allowlist can only make the boundary tighter.
			const baseSet = new Set((data.bases ?? []).map((base) => base.path));
			data.roots = (data.roots ?? []).filter(
				(root) => root.path === projectRoot || (!path.basename(root.path).startsWith('.') && !baseSet.has(root.path)),
			);
		} catch (error) {
			data.error = String(error?.message || error);
		}
		rootsCache = { at: now, data };
		return data;
	}

	async function allowedRoots() {
		const data = await discovery();
		return (data.roots ?? []).map((root) => root.path);
	}

	/** Resolves a client-supplied root to an allowed one, or falls back. */
	async function resolveRoot(requested) {
		if (!requested) return { root: projectRoot, rejected: false };
		const data = await discovery();
		if (typeof data.isAllowedRoot === 'function' && !data.isAllowedRoot(data, requested)) {
			return { root: projectRoot, rejected: true };
		}
		let resolved = null;
		try {
			resolved = fs.realpathSync(requested);
		} catch {
			return { root: projectRoot, rejected: true };
		}
		const match = (data.roots ?? []).find((root) => {
			try {
				return fs.realpathSync(root.path) === resolved;
			} catch {
				return root.path === requested;
			}
		});
		return match ? { root: match.path, rejected: false } : { root: projectRoot, rejected: true };
	}

	/**
	 * Runs one section. A module that fails to import or throws becomes an
	 * error row carrying the real message — never fabricated data, never a
	 * silent empty section.
	 */
	async function runSection(section, root) {
		const modulePath = path.join(LIB_DIR, section.module);
		try {
			const mod = await import(`file://${modulePath}`);
			const fn = mod[section.fn];
			if (typeof fn !== 'function') {
				return { ok: false, error: `${section.module} does not export ${section.fn}()`, modulePath };
			}
			const data = await fn({ home, projectRoot: root });
			return { ok: true, data, modulePath };
		} catch (error) {
			return { ok: false, error: String(error?.stack || error?.message || error), modulePath };
		}
	}

	/**
	 * Cross-section arithmetic: what the harness ACTUALLY costs per session.
	 *
	 * The scanners each report everything they find on disk, which is correct —
	 * a scanner must not hide a file because something else says it is inactive.
	 * But summing them naively overstates the real cost badly:
	 *
	 *   - the plugin cache keeps several versions of the same plugin side by
	 *     side, so its skills get counted once per cached version;
	 *   - disabled plugins still have their skills on disk;
	 *   - a skill shadowed by a higher-scope copy is never loaded;
	 *   - `off` and `user-invocable-only` skills are hidden from the model.
	 *
	 * `discovered` is what exists; `effective` is what a session pays for. The
	 * panel shows both, because a headline number that is quietly wrong is worse
	 * than no headline number at all.
	 */
	function buildDerived(sections, harness = 'claude') {
		const derived = { memory: null, skills: null, hooks: null, note: null };

		// Every list below comes from a scanner this function does not control —
		// including Codex scanners written after it. A payload of the wrong shape
		// must leave `derived.memory` or `derived.skills` null, never throw and take
		// the whole state down with it.
		const asRows = (value, key) => {
			const list = Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
			return list.filter((item) => item && typeof item === 'object');
		};

		const memory = sections.memory?.ok ? sections.memory.data : null;
		const memoryEntries = asRows(memory, 'entries');
		if (memoryEntries.length) {
			const injected = memoryEntries.filter((entry) => entry.alwaysInjected);
			derived.memory = {
				alwaysInjectedFiles: injected.length,
				alwaysInjectedBytes: injected.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
				estimatedTokens: injected.reduce((sum, entry) => sum + (entry.estimatedTokens || 0), 0),
				onDemandFiles: memoryEntries.length - injected.length,
				// A count is not an answer to "which files": the headline said two were
				// resident and left the reader to go find them. Name them here, with
				// what each contributes, so the total can be checked against its parts
				// without leaving the card.
				alwaysInjectedPaths: injected.map((entry) => ({
					layer: entry.layer ?? null,
					path: entry.path ?? null,
					bytes: entry.bytes ?? 0,
					estimatedTokens: entry.estimatedTokens ?? 0,
					link: entry.link ?? null,
				})),
			};
		}

		const skills = asRows(sections.skills?.ok ? sections.skills.data : null, 'skills');
		const pluginsData = sections.plugins?.ok ? sections.plugins.data : null;
		const plugins = asRows(pluginsData, 'plugins');
		if (skills.length) {
			// plugins-scan already resolves one active version per plugin, so a
			// path prefix match filters stale cached versions and disabled plugins
			// in one step — no version comparison of our own to get wrong.
			const activePluginPaths = plugins
				.filter((plugin) => plugin.enabled)
				.map((plugin) => plugin.path)
				.filter(Boolean);
			const fromActivePlugin = (skill) =>
				skill.layer !== 'plugin' || activePluginPaths.some((base) => String(skill.path || '').startsWith(`${base}/`));
			const visibleToModel = (skill) => skill.state === 'on' || skill.state === 'name-only';

			const effective = skills.filter((skill) => visibleToModel(skill) && !skill.shadowedBy && fromActivePlugin(skill));
			const chars = (list) => list.reduce((sum, skill) => sum + (skill.listingChars || 0), 0);

			derived.skills = {
				discovered: { count: skills.length, chars: chars(skills), estimatedTokens: Math.round(chars(skills) / 4) },
				effective: {
					count: effective.length,
					chars: chars(effective),
					estimatedTokens: Math.round(chars(effective) / 4),
					// Half of what loads was never written here. The headline count alone
					// cannot say that, and it is the first thing worth knowing about it —
					// the two add up to `count`, so the split is checkable on sight.
					mine: effective.filter((skill) => skill.layer !== 'plugin').length,
					fromPlugin: effective.filter((skill) => skill.layer === 'plugin').length,
				},
				excluded: {
					hiddenByOverride: skills.filter((skill) => !visibleToModel(skill)).length,
					shadowed: skills.filter((skill) => skill.shadowedBy).length,
					staleOrDisabledPlugin: skills.filter((skill) => !fromActivePlugin(skill)).length,
					// The combined figure above answers "how many never load"; these two
					// answer "why", which is the question a wall of same-named rows
					// actually raises. Only skills-scan can tell them apart, because
					// only it knows which cached version is the active one.
					staleCachedVersion: skills.filter((skill) => skill.activeVersion === false).length,
					disabledPlugin: skills.filter((skill) => skill.activeVersion !== false && !fromActivePlugin(skill)).length,
				},
			};
		}

		// Hook output is context too, and the one part no file on disk accounts
		// for. Measured on the newest transcript that fired a hook: once at
		// session start, and again on every prompt — kept apart because a
		// per-turn hook's cost is its output per prompt, not its session total.
		// Claude only: Codex's captures are the AGENTS.md chain and the skill
		// instructions themselves, already counted above.
		const injected = harness === 'claude' && sections.injected?.ok ? sections.injected.data : null;
		const captures = [
			...asRows(injected?.sessionStartOutput).map((capture) => ({ ...capture, phase: 'start' })),
			...asRows(injected?.userPromptSubmitOutput).map((capture) => ({ ...capture, phase: 'turn' })),
		];
		if (captures.length) {
			const newest = captures.reduce(
				(best, capture) => (!best || String(capture.capturedAt) > String(best.capturedAt) ? capture : best),
				null,
			);
			// Eight scripts on one event all record the same hookName, so the name
			// alone cannot say which one costs 5 KB. The first line of what each
			// injected can — "PONYTAIL MODE ACTIVE", "graphify freshness check".
			const firstLine = (text) =>
				String(text || '')
					.split('\n')
					.map((line) => line.trim())
					.find(Boolean)
					?.slice(0, 80) ?? '';
			const byHook = new Map();
			for (const capture of captures.filter((capture) => capture.transcriptPath === newest.transcriptPath)) {
				const label = firstLine(capture.text) || '(no text)';
				const key = `${capture.phase}|${capture.hookName || '(unnamed)'}|${label}`;
				const row = byHook.get(key) ?? {
					phase: capture.phase,
					event: capture.hookEvent ?? null,
					hookName: capture.hookName || '(unnamed)',
					label,
					runs: 0,
					bytes: 0,
				};
				row.runs += 1;
				row.bytes += capture.bytes || 0;
				byHook.set(key, row);
			}
			const hooks = [...byHook.values()]
				.map((hook) => ({ ...hook, estimatedTokens: Math.round(hook.bytes / 4) }))
				.sort((a, b) => b.bytes - a.bytes);
			const startBytes = hooks.filter((hook) => hook.phase === 'start').reduce((sum, hook) => sum + hook.bytes, 0);
			const perTurnBytes = Math.round(
				hooks.filter((hook) => hook.phase === 'turn').reduce((sum, hook) => sum + hook.bytes / hook.runs, 0),
			);
			derived.hooks = {
				transcriptPath: newest.transcriptPath,
				capturedAt: newest.capturedAt ?? null,
				startBytes,
				startEstimatedTokens: Math.round(startBytes / 4),
				perTurnBytes,
				perTurnEstimatedTokens: Math.round(perTurnBytes / 4),
				hooks,
			};
		}

		if (derived.memory && derived.skills) {
			// What the headline covers, and — just as important — what it does not.
			// The estimate is built from files this panel can read, so everything
			// the harness injects from somewhere else is outside it. Naming the
			// gaps keeps a number that is necessarily partial from reading as a
			// total.
			derived.note =
				'Always-resident estimate = memory chain + effective skill listing' +
				(derived.hooks ? ' + hook output at session start' : '') +
				', and nothing else: the slash-command listing, skills bundled with the CLI (no file in any scanned scope), ' +
				'per-turn hook output and the base system prompt are all resident too and are NOT counted here. Disk-based ' +
				'approximation at 4 chars per token; run /context for the live measurement.';
			derived.totalEstimatedTokens =
				derived.memory.estimatedTokens +
				derived.skills.effective.estimatedTokens +
				(derived.hooks?.startEstimatedTokens ?? 0);
		}
		return derived;
	}

	/**
	 * Merges transcript-derived usage counts into the sections that have no
	 * counter of their own.
	 *
	 * Skills and plugins carry a lifetime counter in ~/.claude.json. MCP servers,
	 * commands, subagents and hooks do not — their only record is in session
	 * transcripts, so their number means "in the last N sessions", a WINDOW and
	 * not a total. The two must never be presented as the same measurement, which
	 * is why the window is reported alongside in state.usage.scanned.
	 */

	/**
	 * Usage counts, cached far longer than the rest of the state.
	 *
	 * The scan streams the 50 most recent transcripts — 112 MB and ~360 ms on
	 * this machine. The section cache is 1.5 s, so running it there would re-read
	 * 112 MB on every refresh. Usage also moves slowly: it is a count over the
	 * last N sessions, so a five-minute cache changes nothing a reader would
	 * notice. `Refresh` with force=1 bypasses it.
	 *
	 * Each harness counts its own sessions from its own store, so the module is
	 * looked up in the registry. A harness whose usage scanner does not exist yet
	 * gets the same graceful empty shape as a scanner that threw — mergeUsage then
	 * simply adds no counters, and every row still renders.
	 */
	async function usageFor(harness, root, { force = false } = {}) {
		const now = Date.now();
		const key = `${harness.id}:${root}`;
		const hit = usageCache.get(key);
		if (!force && hit && now - hit.at < USAGE_CACHE_MS) return hit.usage;
		let usage;
		try {
			const mod = await import(`file://${path.join(LIB_DIR, harness.usageModule)}`);
			if (typeof mod.scanUsage !== 'function') {
				throw new Error(`${harness.usageModule} does not export scanUsage()`);
			}
			usage = await mod.scanUsage({
				home,
				projectRoot: root,
				limitSessions: Number(envSetting('USAGE_SESSIONS') || 50),
			});
		} catch (error) {
			usage = {
				error: String(error?.message || error),
				mcpServers: [],
				commands: [],
				subagents: [],
				hooks: [],
			};
		}
		usageCache.set(key, { at: now, usage });
		return usage;
	}

	/**
	 * Stamps every clustered section with its taxonomy.
	 *
	 * Runs AFTER mergeUsage on purpose: mergeUsage synthesises rows that have no
	 * definition file (the built-in subagents), and a row the panel invented still
	 * has to answer "which cluster is this" like any other.
	 */
	function tagClusters(sections, curation) {
		for (const id of Object.keys(sections)) {
			if (!isClusteredKind(id)) continue;
			const section = sections[id];
			if (!section?.ok) continue;
			const data = section.data;
			const list = Array.isArray(data) ? data : (data?.[id] ?? data?.servers ?? data?.skills ?? null);
			if (!Array.isArray(list)) continue;
			applyTaxonomy(id, list, curation?.clusters);
			if (reportsGaps(id)) section.clusterGaps = emptyClusters(list);
		}
	}

	async function buildState({
		force = false,
		harness = DEFAULT_HARNESS,
		root = projectRoot,
		rootRejected = false,
	} = {}) {
		// A caller that got past the route guard already has a real id; falling back
		// here keeps internal callers (the file preview, the hook-script allowlist)
		// from having to repeat the check.
		const entry = HARNESSES[harness] ?? HARNESSES[DEFAULT_HARNESS];
		const key = `${entry.id}:${root}`;
		const now = Date.now();
		const hit = cache.get(key);
		if (!force && hit && now - hit.at < STATE_CACHE_MS) return hit.state;
		if (force) usageCache.delete(key);

		const results = await Promise.all(
			entry.sections.map(async (section) => [section.id, { ...section, ...(await runSection(section, root)) }]),
		);
		const sections = Object.fromEntries(results);

		const usage = await usageFor(entry, root);
		mergeUsage(sections, usage);
		// Read per ROOT, not per process: switching working tree switches which
		// workspace's curation applies, the same way every other fact does.
		const curation = (() => {
			try {
				return readCuration({ projectRoot: root });
			} catch (error) {
				return { path: null, exists: false, error: String(error?.message || error), warnings: [], bypasses: [], clusters: null };
			}
		})();
		tagClusters(sections, curation);
		const state = {
			generatedAt: new Date().toISOString(),
			home,
			projectRoot: root,
			launchRoot: projectRoot,
			rootRejected,
			node: process.version,
			serverStartedAt: startedAt,
			build: buildStamp,
			port: boundPort,
			sections,
			// Which tree these facts came from, and where it deviates from the
			// anchor branch. The panel reads the WORKING TREE on purpose: that is
			// what governs the running session. Most of what it reads has no
			// branch at all (see lib/git-context.mjs).
			git: await (async () => {
				try {
					const [gitMod, rootsMod] = await Promise.all([
						import(`file://${path.join(LIB_DIR, 'git-context.mjs')}`),
						import(`file://${path.join(LIB_DIR, 'workspace-roots.mjs')}`),
					]);
					// `dev` is this repo's anchor, but the panel now reads other
					// projects too — resolve per repo rather than assuming.
					const preferred = envSetting('ANCHOR_REF') || 'dev';
					const anchor = rootsMod.resolveAnchorRef({ projectRoot: root, preferred });
					const context = gitMod.gitContext({ projectRoot: root, anchorRef: anchor.ref || preferred });
					return { ...context, anchorSource: anchor.source, anchorTried: anchor.tried };
				} catch (error) {
					return { available: false, error: String(error?.message || error) };
				}
			})(),
			usage,
			// The judgements only a human in THIS repo can make: which cluster a
			// home-grown skill serves, and which guards have a verified hole. The
			// panel ships neither — it reads them, or says there are none.
			curation,
			derived: buildDerived(sections, entry.id),
			meta: {
				readOnly: true,
				// Whose harness these facts describe, and what else could have been
				// asked for. The client renders the selector from `available` rather
				// than hardcoding a list that would drift from the server's.
				harness: {
					id: entry.id,
					label: entry.label,
					available: harnessIds().map((id) => ({ id, label: HARNESSES[id].label })),
				},
				baseSystemPrompt: entry.baseSystemPrompt,
				sectionOrder: entry.sections.map((section) => ({ id: section.id, label: section.label })),
				// Cluster definitions, with the one-line trigger each group header shows.
				// The per-row label/order are stamped onto the rows themselves, so a
				// section-only refresh still renders correct group headers without this.
				clusters: clusterCatalog(),
			},
		};
		cache.set(key, { at: now, state });
		return state;
	}

	function sendJson(res, statusCode, payload) {
		const body = JSON.stringify(payload, null, statusCode === 200 ? 0 : 2);
		res.writeHead(statusCode, {
			'Content-Type': MIME['.json'],
			'Content-Length': Buffer.byteLength(body),
			'Cache-Control': 'no-store',
		});
		res.end(body);
	}

	function serveStatic(res, urlPath) {
		const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
		const target = path.join(PUBLIC_DIR, relative);
		// Containment check: a crafted path must not escape public/.
		if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
			res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('forbidden');
			return;
		}
		let content;
		try {
			content = fs.readFileSync(target);
		} catch (error) {
			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end(`not found: ${relative} (${String(error?.code || 'ENOENT')})`);
			return;
		}
		res.writeHead(200, {
			'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
			'Content-Length': content.length,
			'Cache-Control': 'no-store',
		});
		res.end(content);
	}

	/**
	 * Serves the body of a configured hook script. The requested path must
	 * appear in the scanned hooks inventory — an arbitrary path is refused, so
	 * this endpoint cannot be used to read the filesystem at large.
	 *
	 * The allowlist is built from the REQUESTED harness's hooks section: Codex
	 * hooks live in a different tree, and reading one must not require it to also
	 * be a Claude hook. Each harness reads its own scripts through its own
	 * scanner module, so neither can widen the other's boundary.
	 */
	async function serveHookScript(res, requested, { harness = DEFAULT_HARNESS, root = projectRoot } = {}) {
		const entry = HARNESSES[harness] ?? HARNESSES[DEFAULT_HARNESS];
		const state = await buildState({ harness: entry.id, root });
		const hooks = state.sections.hooks;
		if (!hooks?.ok) {
			sendJson(res, 503, { error: 'hooks section unavailable', detail: hooks?.error ?? null });
			return;
		}
		const rows = Array.isArray(hooks.data) ? hooks.data : (hooks.data?.hooks ?? []);
		const allowed = new Set(rows.map((row) => row?.scriptPath).filter(Boolean));
		if (!requested || !allowed.has(requested)) {
			sendJson(res, 403, { error: 'path is not a configured hook script', requested });
			return;
		}
		const hooksModule = entry.sections.find((section) => section.id === 'hooks')?.module ?? 'hooks-scan.mjs';
		try {
			const mod = await import(`file://${path.join(LIB_DIR, hooksModule)}`);
			if (typeof mod.readHookScript === 'function') {
				sendJson(res, 200, mod.readHookScript(requested));
				return;
			}
			sendJson(res, 503, { error: `${hooksModule} does not export readHookScript()` });
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message || error) });
		}
	}

	/**
	 * Every absolute path the current state already exposed.
	 *
	 * This is the allowlist for the file preview: you may look at a file the
	 * panel already showed you a row for, and nothing else. It is derived from
	 * the served state rather than from the request, so the endpoint cannot be
	 * walked outwards into the filesystem.
	 */
	function pathsInState(state) {
		const found = new Set();
		const visit = (node) => {
			if (Array.isArray(node)) {
				for (const item of node) visit(item);
				return;
			}
			if (!node || typeof node !== 'object') return;
			for (const [key, value] of Object.entries(node)) {
				if (typeof value === 'string' && PATH_KEYS.has(key) && value.startsWith('/')) found.add(value);
				else visit(value);
			}
		};
		visit(state.sections);
		visit(state.git);
		return found;
	}

	/**
	 * Serves one file for the in-panel preview. The vscode:// deep link only
	 * works in a real browser — inside VSCode's Simple Browser the webview
	 * blocks external protocol navigation — so the panel carries its own reader
	 * and never depends on the editor being reachable.
	 */
	async function serveFile(res, requested, { harness = DEFAULT_HARNESS, root = projectRoot } = {}) {
		const state = await buildState({ harness, root });
		if (!requested || !pathsInState(state).has(requested)) {
			sendJson(res, 403, { error: 'path is not part of the current inventory', requested });
			return;
		}
		try {
			const [sourceMod, maskMod] = await Promise.all([
				import(`file://${path.join(LIB_DIR, 'source-file.mjs')}`),
				import(`file://${path.join(LIB_DIR, 'mask.mjs')}`),
			]);
			const file = sourceMod.readSourceFile(requested);
			const content = file.content == null ? null : maskMod.redactConfigText(file.content);
			const truncated = content != null && content.length > MAX_PREVIEW_CHARS;
			sendJson(res, 200, {
				path: file.path,
				exists: file.exists,
				readable: file.readable,
				bytes: file.size,
				isSymlink: file.isSymlink,
				symlinkTarget: file.symlinkTarget,
				error: file.error,
				truncated,
				content: truncated ? content.slice(0, MAX_PREVIEW_CHARS) : content,
			});
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message || error) });
		}
	}

	function broadcast(event, payload) {
		const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
		for (const client of sseClients) {
			try {
				client.write(frame);
			} catch {
				sseClients.delete(client);
			}
		}
	}

	let debounce = null;
	let pendingPath = null;
	let pendingHarnesses = new Set();

	/**
	 * Coalesces a burst of file changes into one `update` event.
	 *
	 * The payload names the harness the changed file belongs to, so a client
	 * showing Codex does not re-read everything because a Claude settings file
	 * moved. `harness: null` means "cannot attribute this to one" — a path both
	 * harnesses read, or several harnesses changing inside one debounce window —
	 * and the client must refetch on those. Under-reporting here would show a
	 * stale panel, which is the failure mode this whole tool exists to prevent,
	 * so anything ambiguous resolves to null.
	 *
	 * The state cache is cleared WHOLESALE rather than per harness: it holds at
	 * most a few seconds of arithmetic, and a partial invalidation that got the
	 * mapping wrong would serve a stale answer confidently.
	 */
	function scheduleBroadcast(changedPath, harness = null) {
		pendingPath = changedPath;
		pendingHarnesses.add(harness ?? null);
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			cache.clear();
			const attributed = [...pendingHarnesses];
			const only = attributed.length === 1 && attributed[0] !== null ? attributed[0] : null;
			broadcast('update', { changed: pendingPath, harness: only, at: new Date().toISOString() });
			pendingPath = null;
			pendingHarnesses = new Set();
		}, WATCH_DEBOUNCE_MS);
	}

	/**
	 * Every watched path, mapped to the harness it belongs to.
	 *
	 * BOTH harnesses are watched from boot, whichever one the browser is showing:
	 * watching a handful of files that mostly do not exist costs nothing, and a
	 * watcher started lazily on first selection would miss the edit that happened
	 * while the other view was open. A path claimed by both maps to null.
	 */
	function watchPlan() {
		const plan = new Map();
		for (const id of harnessIds()) {
			for (const target of harnessWatchTargets(id, { home, projectRoot })) {
				if (!plan.has(target)) plan.set(target, id);
				else if (plan.get(target) !== id) plan.set(target, null);
			}
		}
		return plan;
	}

	function startWatchers() {
		for (const [target, harness] of watchPlan()) {
			if (watchers.has(target)) continue;
			try {
				const watcher = fs.watch(target, () => scheduleBroadcast(target, harness));
				watcher.on('error', () => {});
				watchers.set(target, watcher);
			} catch {
				// A file that does not exist yet is simply not watched. Absence is
				// reported by the scanners, not invented here.
			}
		}
	}

	const server = http.createServer((req, res) => {
		const { pathname, searchParams } = new URL(req.url, 'http://127.0.0.1');

		// Read-only gate: refuse every mutating verb before routing. There is no
		// write path behind any of them, and this makes that checkable.
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
			res.end('405 — this panel is read-only; only GET is served');
			return;
		}

		// The snapshot differ is a pure, import-free module, so the browser runs the
		// exact same code the tests cover. Serving this ONE file by name keeps the
		// logic single-sourced without exposing lib/ as a directory.
		if (pathname === '/lib/snapshot-diff.mjs') {
			try {
				const body = fs.readFileSync(path.join(LIB_DIR, 'snapshot-diff.mjs'));
				res.writeHead(200, { 'Content-Type': MIME['.js'], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
				res.end(body);
			} catch (error) {
				res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end(String(error?.message || error));
			}
			return;
		}

		if (pathname === '/api/roots') {
			discovery()
				.then(async (data) => {
					let launchRepoMain = null;
					try {
						const mod = await import(`file://${path.join(LIB_DIR, 'worktree-drift.mjs')}`);
						const scan = mod.scanWorktreeDrift({ projectRoot });
						launchRepoMain = (scan?.worktrees ?? []).find((tree) => tree.isMain)?.path ?? null;
					} catch {
						launchRepoMain = null;
					}
					// Label each root by its BRANCH where there is one: a worktree is
					// how a branch is checked out, and the branch is the identity the
					// reader is choosing between. Projects with no git still appear —
					// the panel reads them fine, it just cannot offer branch context.
					sendJson(res, 200, {
						launchRoot: projectRoot,
						bases: data.bases ?? [],
						error: data.error ?? null,
						roots: (data.roots ?? []).map((root) => ({
							path: root.path,
							name: root.name,
							branch: (root.branch || '').replace(/^refs\/heads\//, '') || null,
							isGitRepo: root.isGitRepo === true,
							isWorktree: root.isWorktree === true,
							// `isMain` means "the main worktree of the repo the panel was
							// launched from" — NOT merely "a git repo that is not a linked
							// worktree", which is true of every standalone project here and
							// made the default-root picker land on an unrelated repo.
							isMain: launchRepoMain !== null && root.path === launchRepoMain,
							isRepoRoot: root.isGitRepo === true && root.isWorktree !== true,
							hasClaudeDir: root.hasClaudeDir === true,
							hasClaudeMd: root.hasClaudeMd === true,
						})),
					});
				})
				.catch((error) => sendJson(res, 500, { error: String(error?.message || error) }));
			return;
		}

		// `?harness=` decides WHOSE configuration the next four routes describe.
		// Refusing an unknown id here, once, keeps every handler below free of the
		// question — and keeps a typo from being answered with the default
		// harness's inventory as if it were the requested one.
		const harness = resolveHarness(searchParams.get('harness'));
		const refuseHarness = () =>
			sendJson(res, 400, { error: 'unknown harness', requested: harness.requested, known: harnessIds() });

		if (pathname === '/api/state') {
			if (!harness.ok) {
				refuseHarness();
				return;
			}
			resolveRoot(searchParams.get('root'))
				.then(({ root, rejected }) =>
					buildState({
						force: searchParams.get('force') === '1',
						harness: harness.id,
						root,
						rootRejected: rejected,
					}),
				)
				.then((state) => sendJson(res, 200, state))
				.catch((error) => sendJson(res, 500, { error: String(error?.message || error) }));
			return;
		}

		if (pathname.startsWith('/api/section/')) {
			if (!harness.ok) {
				refuseHarness();
				return;
			}
			const id = pathname.slice('/api/section/'.length);
			// Validated against THIS harness's registry: `execpolicy` is a real
			// section for Codex and no section at all for Claude, and the 404 has to
			// list the ids the caller could actually have asked for.
			const known = sectionIds(harness.id);
			if (!known.includes(id)) {
				sendJson(res, 404, { error: 'unknown section', id, harness: harness.id, known });
				return;
			}
			resolveRoot(searchParams.get('root'))
				.then(({ root, rejected }) => buildState({ harness: harness.id, root, rootRejected: rejected }))
				.then((state) => sendJson(res, 200, state.sections[id]))
				.catch((error) => sendJson(res, 500, { error: String(error?.message || error) }));
			return;
		}

		if (pathname === '/api/file') {
			if (!harness.ok) {
				refuseHarness();
				return;
			}
			resolveRoot(searchParams.get('root'))
				.then(({ root }) => serveFile(res, searchParams.get('path'), { harness: harness.id, root }))
				.catch((error) => sendJson(res, 500, { error: String(error?.message || error) }));
			return;
		}

		if (pathname === '/api/hook-script') {
			if (!harness.ok) {
				refuseHarness();
				return;
			}
			resolveRoot(searchParams.get('root'))
				.then(({ root }) => serveHookScript(res, searchParams.get('path'), { harness: harness.id, root }))
				.catch((error) => sendJson(res, 500, { error: String(error?.message || error) }));
			return;
		}

		if (pathname === '/api/events') {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			});
			res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
			sseClients.add(res);
			const heartbeat = setInterval(() => {
				try {
					res.write(': heartbeat\n\n');
				} catch {
					clearInterval(heartbeat);
				}
			}, SSE_HEARTBEAT_MS);
			req.on('close', () => {
				clearInterval(heartbeat);
				sseClients.delete(res);
			});
			return;
		}

		serveStatic(res, pathname);
	});

	return {
		server,
		buildState,
		startWatchers,
		listen(port = DEFAULT_PORT) {
			server.on('error', (error) => {
				if (error?.code === 'EADDRINUSE') {
					log(`port ${port} already in use — assuming the panel is already running`);
					process.exit(0);
				}
				log(`server error: ${String(error?.message || error)}`);
				process.exit(1);
			});
			boundPort = port;
			server.listen(port, '127.0.0.1', () => {
				startWatchers();
				log(`Harness Control Panel -> http://127.0.0.1:${port}`);
				log(`  repo: ${projectRoot}`);
				log('  read-only: GET and SSE only');
			});
			return server;
		},
	};
}

/**
 * Whether this file is the program being run, rather than a module somebody
 * imported. Compared through realpath on both sides because Node resolves a
 * module URL to the real path while argv keeps whatever the caller typed: on
 * macOS `/tmp` and `/var` are symlinks into `/private`, so a launcher that
 * resolves its own directory produced two spellings of the same file, the
 * check said "imported", and the process loaded the entire server, listened to
 * nothing and exited 0 in silence.
 */
const invokedDirectly = (() => {
	const entry = process.argv[1];
	if (!entry) return false;
	const self = fileURLToPath(import.meta.url);
	const resolved = path.resolve(entry);
	if (resolved === self) return true;
	try {
		return fs.realpathSync(resolved) === fs.realpathSync(self);
	} catch {
		return false;
	}
})();
if (invokedDirectly) {
	const projectRoot = envSetting('REPO') || process.cwd();
	const port = Number(envSetting('PORT') || DEFAULT_PORT);
	createPanelServer({ projectRoot, log: (message) => console.log(message) }).listen(port);
}
