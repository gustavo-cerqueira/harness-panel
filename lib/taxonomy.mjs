/**
 * Operational clustering for skills, slash commands, subagents and MCP servers.
 *
 * The panel used to render each of those as one flat list. At 181 skills that is
 * not an inventory, it is a wall: you cannot see that you own four things which
 * all fire on "something is broken", or that nothing at all covers a stage.
 * Clusters give the list a spine.
 *
 * THE TEST A CLUSTER MUST PASS: you can write ONE sentence that says when it
 * fires, and that sentence distinguishes it from its neighbours. If you cannot,
 * it is not a top-level cluster -- it is a cross-cutting tag, and it does not
 * belong here. That is why there are eleven of these and not twenty-five: a
 * taxonomy fine enough to be elegant is too fine to route with.
 *
 * WHERE A LABEL COMES FROM, and why it is not guessed:
 *
 *   exact  -- curated below, by qualified name. The only fully trustworthy kind.
 *   family -- a `plugin:*` rule. Covers new skills of a known plugin the moment
 *             they appear, at the cost of being a rule about the plugin rather
 *             than about the skill.
 *   none   -- nothing matched, so it lands in `unclassified` and is rendered as
 *             its own group with a real count.
 *
 * That last one is the whole point. Sweeping an unknown skill into the nearest
 * plausible cluster hides it exactly where nobody will look for it, and the
 * panel would be inventing a fact it does not have. `clusterSource` travels with
 * every row so the UI can say which of the three produced the label.
 *
 * Frontmatter (`category:` in SKILL.md) is deliberately NOT a source: most
 * skills live in the plugin cache, are not ours to edit, and are wiped on the
 * next plugin update.
 *
 * WHAT SHIPS HERE, and what does not: the maps below name only things a stranger
 * can actually have installed — official plugins and bundled skills. A skill you
 * wrote yourself is not knowable from here, so it is not guessed at and not
 * hardcoded: put it in your workspace's `.claude/harness-curation.json` (see
 * `lib/curation.mjs`), whose entries are passed in as `overrides` and beat
 * everything below.
 */

/**
 * @typedef {'discovery'|'specification'|'planning'|'orchestration'|'execution'|
 *   'verification'|'delivery'|'diagnosis'|'memory'|'governance'|'meta'|'unclassified'} ClusterId
 */

/** Ordered roughly as work flows, so the rendered groups read as a pipeline. */
export const CLUSTERS = [
	{
		id: 'discovery',
		label: 'Discovery',
		trigger: 'Find and bring in what you do not have yet — search the web, the codebase, or an external feed.',
	},
	{
		id: 'specification',
		label: 'Specification',
		trigger: 'Turn an intent into a written contract before any code exists.',
	},
	{
		id: 'planning',
		label: 'Planning',
		trigger: 'Break approved work into ordered, trackable steps — and resume them later.',
	},
	{
		id: 'orchestration',
		label: 'Orchestration',
		trigger: 'Hand work to other agents or sessions, and coordinate them.',
	},
	{
		id: 'execution',
		label: 'Execution',
		trigger: 'Build the thing: write code, scaffold, style, run the app.',
	},
	{
		id: 'verification',
		label: 'Verification',
		trigger: 'Check work already written against a standard — review, audit, QA.',
	},
	{
		id: 'delivery',
		label: 'Delivery & Operations',
		trigger: 'Move finished work out of your tree: merge, archive, release, deploy, operate.',
	},
	{
		id: 'diagnosis',
		label: 'Diagnosis',
		trigger: 'Something already built is broken or slow — find the cause.',
	},
	{
		id: 'memory',
		label: 'Memory & Context',
		trigger: 'Persist context now so a later session can recall it.',
	},
	{
		id: 'governance',
		label: 'Governance',
		trigger: 'Guard rails and human sign-off — security, locks, gates, stop signals, owner decisions.',
	},
	{
		id: 'meta',
		label: 'Meta',
		trigger: 'Change the harness itself: skills, config, hooks, plugins, modes, prompts.',
	},
	{
		id: 'unclassified',
		label: 'Unclassified',
		trigger: 'No curated entry and no family rule matched. Listed as itself rather than guessed into a neighbour.',
	},
];

export const UNCLASSIFIED = 'unclassified';

const CLUSTER_BY_ID = new Map(CLUSTERS.map((cluster, index) => [cluster.id, { ...cluster, order: index }]));

/** Every id used below must exist in CLUSTERS, or the map is a silent typo. */
function assertKnown(map, where) {
	for (const [key, cluster] of Object.entries(map)) {
		if (!CLUSTER_BY_ID.has(cluster)) throw new Error(`taxonomy: ${where}.${key} -> unknown cluster "${cluster}"`);
	}
	return map;
}

/**
 * Curated, by qualified name. An entry here always beats a family rule, which is
 * how the exceptions inside a plugin family are expressed (`claude-mem:*` is
 * memory, but `claude-mem:what-the` is diagnosis).
 */
const SKILL_EXACT = assertKnown(
	{
		// --- superpowers ---
		'superpowers:brainstorming': 'specification',
		'superpowers:writing-plans': 'planning',
		'superpowers:executing-plans': 'execution',
		'superpowers:subagent-driven-development': 'orchestration',
		'superpowers:dispatching-parallel-agents': 'orchestration',
		'superpowers:requesting-code-review': 'verification',
		'superpowers:receiving-code-review': 'verification',
		'superpowers:verification-before-completion': 'verification',
		'superpowers:systematic-debugging': 'diagnosis',
		'superpowers:test-driven-development': 'execution',
		'superpowers:using-git-worktrees': 'delivery',
		'superpowers:finishing-a-development-branch': 'delivery',
		'superpowers:using-superpowers': 'meta',
		'superpowers:writing-skills': 'meta',

		// --- claude-mem: episodic memory plugin, with the parts that are not memory ---
		'claude-mem:babysit': 'delivery',
		'claude-mem:version-bump': 'delivery',
		'claude-mem:claude-code-plugin-release': 'delivery',
		'claude-mem:wowerpoint': 'delivery',
		'claude-mem:what-the': 'diagnosis',
		'claude-mem:oh-my-issues': 'diagnosis',
		'claude-mem:mode-creator': 'meta',
		'claude-mem:how-it-works': 'meta',
		'claude-mem:design-is': 'execution',
		'claude-mem:do': 'execution',
		'claude-mem:make-plan': 'planning',
		'claude-mem:smart-explore': 'discovery',
		'claude-mem:learn-codebase': 'discovery',
		'claude-mem:pathfinder': 'discovery',

		// --- codex ---
		'codex:gpt-5-4-prompting': 'meta',

		// --- caveman ---
		'caveman:caveman-review': 'verification',
		'caveman:caveman-commit': 'delivery',
		'caveman:cavecrew': 'orchestration',

		// --- built-in / bundled ---
		'code-review': 'verification',
		'security-review': 'governance',
		simplify: 'verification',
		run: 'execution',
		init: 'specification',
		schedule: 'orchestration',
		loop: 'orchestration',
		'update-config': 'meta',
		'keybindings-help': 'meta',
		'fewer-permission-prompts': 'meta',
		'claude-api': 'discovery',
		'claude-in-chrome': 'execution',
		design: 'execution',
		dataviz: 'execution',
		'artifact-design': 'execution',
		'artifact-diagramming': 'execution',
		'artifact-capabilities': 'execution',
	},
	'SKILL_EXACT',
);

/**
 * Family rules, applied only when nothing exact matched. A family rule is a
 * claim about a PLUGIN, not about a skill — right for the plugin's centre of
 * gravity, and wrong at its edges, which is what SKILL_EXACT above is for.
 */
const SKILL_FAMILIES = [
	[/^basic-memory:/, 'memory'],
	[/^memory-/, 'memory'],
	[/^claude-mem:/, 'memory'],
	[/^codex:/, 'orchestration'],
	[/^caveman:/, 'meta'],
	[/^claude-security:/, 'governance'],
	[/^claude-code-setup:/, 'meta'],
	[/^frontend-design:/, 'execution'],
	[/^agent-sdk-dev:/, 'execution'],
	[/^superpowers:/, 'meta'],
	[/^opsx:/, 'specification'],
];

const COMMAND_EXACT = assertKnown(
	{
		'opsx:apply': 'execution',
		'opsx:archive': 'delivery',
		'opsx:explore': 'discovery',
		'opsx:propose': 'specification',
		'opsx:sync': 'specification',
		'caveman:caveman-commit': 'delivery',
		'caveman:caveman-review': 'verification',
		'caveman:caveman-init': 'meta',
		'caveman:caveman-stats': 'meta',
		'caveman:caveman': 'meta',
		'agent-sdk-dev:new-sdk-app': 'execution',
		'codex:adversarial-review': 'verification',
		'codex:review': 'verification',
		'codex:rescue': 'orchestration',
		'codex:cancel': 'orchestration',
		'codex:result': 'orchestration',
		'codex:status': 'orchestration',
		'codex:transfer': 'orchestration',
		'codex:setup': 'meta',
	},
	'COMMAND_EXACT',
);

const COMMAND_FAMILIES = [
	[/^codex:/, 'orchestration'],
	[/^caveman:/, 'meta'],
	[/^opsx:/, 'specification'],
];

const AGENT_EXACT = assertKnown(
	{
		'cavecrew-reviewer': 'verification',
		'agent-sdk-verifier-py': 'verification',
		'agent-sdk-verifier-ts': 'verification',
		'patch-verifier': 'verification',
		'scan-verifier': 'verification',
		'code-reviewer': 'verification',
		'cavecrew-builder': 'execution',
		'patch-generator': 'execution',
		'general-purpose': 'execution',
		claude: 'execution',
		'cavecrew-investigator': 'discovery',
		explore: 'discovery',
		Explore: 'discovery',
		'scan-inventory': 'discovery',
		'scan-researcher': 'discovery',
		'claude-code-guide': 'discovery',
		'claude-security': 'governance',
		'codex-rescue': 'orchestration',
		'codex:codex-rescue': 'orchestration',
		Plan: 'planning',
		'statusline-setup': 'meta',
	},
	'AGENT_EXACT',
);

const AGENT_FAMILIES = [
	[/^caveman:/, 'meta'],
	[/^codex:/, 'orchestration'],
	[/reviewer$|^review-|verifier/i, 'verification'],
];

const MCP_EXACT = assertKnown(
	{
		'basic-memory': 'memory',
		obsidian: 'memory',
		'mcp-search': 'memory',
		'claude-peers': 'orchestration',
		context7: 'discovery',
		playwright: 'execution',
		'claude-in-chrome': 'execution',
		ide: 'execution',
	},
	'MCP_EXACT',
);

const MCP_FAMILIES = [
	[/memory|mem-search/i, 'memory'],
	[/playwright|chrome|browser/i, 'execution'],
];

const KINDS = {
	skills: { exact: SKILL_EXACT, families: SKILL_FAMILIES },
	commands: { exact: COMMAND_EXACT, families: COMMAND_FAMILIES },
	agents: { exact: AGENT_EXACT, families: AGENT_FAMILIES },
	mcp: { exact: MCP_EXACT, families: MCP_FAMILIES },
};

/** True when `id` is one of the eleven clusters (plus `unclassified`). */
export function isKnownCluster(id) {
	return CLUSTER_BY_ID.has(id);
}

/** True when this section has a taxonomy at all. */
export function isClusteredKind(kind) {
	return Object.hasOwn(KINDS, kind);
}

/**
 * Which kinds an EMPTY cluster is a real finding for.
 *
 * Skills and slash commands are things this workspace authors, so "no skill
 * fires on `something is broken`" is a gap worth naming. MCP servers and
 * subagents are not stage-shaped — nobody is missing a "planning MCP server" —
 * and listing seven empty clusters under six servers reads as a to-do list the
 * owner never signed up for. A finding nobody should act on is noise, and noise
 * is how a panel teaches you to stop reading it.
 */
const GAP_KINDS = new Set(['skills', 'commands']);

export function reportsGaps(kind) {
	return GAP_KINDS.has(kind);
}

/**
 * Resolves one name to a cluster.
 *
 * @param {string} kind one of skills | commands | agents | mcp
 * @param {{qualifiedName?: string, normalizedName?: string, name?: string}|string} item
 * @param {{skills?: object, commands?: object, agents?: object, mcp?: object}} [overrides]
 *   this workspace's own curation, which beats the shipped maps
 * @returns {{cluster: ClusterId, clusterSource: 'exact'|'family'|'none'}}
 */
export function classify(kind, item, overrides) {
	const rules = KINDS[kind];
	if (!rules) return { cluster: UNCLASSIFIED, clusterSource: 'none' };

	const candidates =
		typeof item === 'string'
			? [item]
			: [item?.qualifiedName, item?.normalizedName, item?.name].filter((value) => typeof value === 'string' && value);

	// The workspace's own map wins: it is the only source that can know what a
	// locally written skill is for, and disagreeing with it would be the panel
	// overruling the one person who does know.
	const curated = overrides?.[kind];
	if (curated) {
		for (const name of candidates) {
			const hit = curated[name];
			if (typeof hit === 'string' && isKnownCluster(hit)) return { cluster: hit, clusterSource: 'exact' };
		}
	}
	for (const name of candidates) {
		const hit = rules.exact[name];
		if (hit) return { cluster: hit, clusterSource: 'exact' };
	}
	for (const name of candidates) {
		for (const [pattern, cluster] of rules.families) {
			if (pattern.test(name)) return { cluster, clusterSource: 'family' };
		}
	}
	return { cluster: UNCLASSIFIED, clusterSource: 'none' };
}

/** The full cluster record (label, trigger, order) for an id. */
export function clusterMeta(id) {
	return CLUSTER_BY_ID.get(id) ?? CLUSTER_BY_ID.get(UNCLASSIFIED);
}

/**
 * Stamps `cluster`, `clusterLabel`, `clusterOrder` and `clusterSource` onto each
 * item IN PLACE. The label and order ride along per item on purpose: the cheap
 * `GET /api/section/<id>` response carries no `meta`, and a group header that
 * cannot name itself after a partial refresh would be a regression.
 */
export function applyTaxonomy(kind, items, overrides) {
	if (!Array.isArray(items) || !isClusteredKind(kind)) return items;
	for (const item of items) {
		if (!item || typeof item !== 'object') continue;
		const { cluster, clusterSource } = classify(kind, item, overrides);
		const meta = clusterMeta(cluster);
		item.cluster = cluster;
		item.clusterLabel = meta.label;
		item.clusterOrder = meta.order;
		item.clusterSource = clusterSource;
	}
	return items;
}

/** Cluster ids that have no member at all, per kind — the coverage gaps. */
export function emptyClusters(items) {
	const seen = new Set((items ?? []).map((item) => item?.cluster).filter(Boolean));
	return CLUSTERS.filter((cluster) => cluster.id !== UNCLASSIFIED && !seen.has(cluster.id)).map(
		(cluster) => cluster.id,
	);
}

/** Cluster definitions for the API `meta` block, order included. */
export function clusterCatalog() {
	return CLUSTERS.map((cluster, index) => ({ ...cluster, order: index }));
}
