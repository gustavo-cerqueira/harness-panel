/**
 * Harness Control Panel — UI.
 *
 * No framework, no build step, no CDN. The panel is read-only: the only
 * "edit" affordance is a vscode:// deep link that hands the file and line to
 * the editor.
 *
 * Scanner sections return different shapes on purpose (a settings merge is not
 * a list of hooks), so each section has a small adapter that normalizes rows to
 * { title, badges, fields, path, line, link, struck }. An unrecognized shape
 * falls back to a readable JSON dump rather than rendering nothing — a blank
 * panel would hide exactly the drift this tool exists to surface.
 */

const OWNER_ONLY = /^ANTHROPIC_MODEL|_AGENT_MODEL$|^EZ_ALL_AGENTS_MODEL$|_CLASSIFIER_MODEL$/;

/**
 * WHICH HARNESS this panel is inventorying.
 *
 * Two agent harnesses run on this machine against this repo — Claude Code and
 * Codex CLI — and they read completely different trees. Everything on screen is
 * relative to one of them, so the choice travels with every API call, is stamped
 * on <body> for the accent, and is mirrored into the URL: `?harness=codex` opens
 * the Codex view for whoever receives the link, which a stored preference alone
 * could never do. That is also why the URL beats localStorage on load.
 */
const HARNESS_STORAGE_KEY = 'ezharness.harness';
const HARNESS_LABELS = { claude: 'Claude Code', codex: 'Codex CLI' };
const DEFAULT_HARNESS = 'claude';

function storedHarness() {
	try {
		return localStorage.getItem(HARNESS_STORAGE_KEY);
	} catch {
		return null; // storage disabled or blocked: the panel still works
	}
}

function initialHarness() {
	const fromUrl = new URLSearchParams(location.search).get('harness');
	const candidate = fromUrl || storedHarness() || '';
	return Object.hasOwn(HARNESS_LABELS, candidate) ? candidate : DEFAULT_HARNESS;
}

let activeHarness = initialHarness();

const harnessLabel = (id) => HARNESS_LABELS[id] || id;

/**
 * The query string every API call carries. `harness` is never omitted, so a
 * request can never be answered by the other harness's cached state by accident.
 */
function apiQuery(extra = {}) {
	const query = new URLSearchParams();
	query.set('harness', activeHarness);
	if (activeRoot) query.set('root', activeRoot);
	for (const [key, value] of Object.entries(extra)) {
		if (value !== null && value !== undefined) query.set(key, String(value));
	}
	return query;
}

/** Header, tab title and the CSS hook the accent hangs off. */
function applyHarnessChrome() {
	const label = harnessLabel(activeHarness);
	document.body.dataset.harness = activeHarness;
	document.title = `Harness Control Panel — ${label}`;
	const heading = document.querySelector('header h1');
	if (heading) heading.textContent = `Harness Control Panel — ${label}`;
}

/** Persists the choice and mirrors it into the address bar without navigating. */
function rememberHarness() {
	try {
		localStorage.setItem(HARNESS_STORAGE_KEY, activeHarness);
	} catch {
		// storage disabled: the URL still carries the choice
	}
	const url = new URL(location.href);
	url.searchParams.set('harness', activeHarness);
	history.replaceState(null, '', url);
}

const el = (tag, props = {}, children = []) => {
	const node = Object.assign(document.createElement(tag), props);
	for (const child of [].concat(children)) {
		if (child == null) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
};

const short = (value, max = 160) => {
	if (value == null) return '';
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
};

const badge = (text, kind) => el('span', { className: `badge ${kind || ''}`, textContent: text });

/**
 * In-panel file preview.
 *
 * The vscode:// deep link is kept — the scheme IS registered on this machine
 * and the link works from a real browser. But inside VSCode's own Simple
 * Browser the webview blocks external protocol navigation, so a panel that
 * offered only that link would be unusable exactly where it is most likely to
 * be opened. The preview makes the panel self-sufficient.
 *
 * The server only serves files already present in the inventory, and redacts
 * secrets by key name before sending, so this cannot become a file browser.
 */
function ensureModal() {
	let modal = document.getElementById('preview');
	if (modal) return modal;
	modal = el('div', { id: 'preview', className: 'modal hidden' });
	const box = el('div', { className: 'modal-box' });
	const head = el('div', { className: 'modal-head' }, [
		el('span', { className: 'modal-title', id: 'preview-title' }),
		el('span', { className: 'modal-meta', id: 'preview-meta' }),
		el('button', { id: 'preview-close', type: 'button', textContent: 'Close' }),
	]);
	box.append(head, el('pre', { className: 'body', id: 'preview-body' }));
	modal.append(box);
	document.body.append(modal);
	const close = () => modal.classList.add('hidden');
	head.querySelector('#preview-close').addEventListener('click', close);
	modal.addEventListener('click', (event) => {
		if (event.target === modal) close();
	});
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') close();
	});
	return modal;
}

async function openPreview(absPath, line) {
	const modal = ensureModal();
	modal.classList.remove('hidden');
	document.getElementById('preview-title').textContent = absPath;
	document.getElementById('preview-meta').textContent = 'reading…';
	const body = document.getElementById('preview-body');
	body.textContent = '';
	try {
		const response = await fetch(`/api/file?${apiQuery({ path: absPath })}`);
		const file = await response.json();
		if (!response.ok || file.error) {
			document.getElementById('preview-meta').textContent = 'unavailable';
			body.textContent = file.error || `HTTP ${response.status}`;
			return;
		}
		document.getElementById('preview-meta').textContent =
			`${file.bytes ?? 0} bytes${file.truncated ? ' · truncated' : ''}${file.isSymlink ? ` · symlink → ${file.symlinkTarget}` : ''} · secrets redacted`;
		const lines = (file.content || '').split('\n');
		body.replaceChildren(
			...lines.map((text, index) => {
				const number = index + 1;
				const row = el('div', { className: number === line ? 'pre-line hit' : 'pre-line' });
				row.append(el('span', { className: 'ln', textContent: String(number).padStart(4, ' ') }), ` ${text}`);
				return row;
			}),
		);
		const hit = body.querySelector('.pre-line.hit');
		if (hit) hit.scrollIntoView({ block: 'center' });
	} catch (error) {
		document.getElementById('preview-meta').textContent = 'failed';
		body.textContent = String(error?.message || error);
	}
}

function copyButton(text) {
	const button = el('button', { textContent: 'copy path', title: text || '' });
	button.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = 'copied';
			setTimeout(() => (button.textContent = 'copy path'), 1200);
		} catch {
			button.textContent = 'copy failed';
		}
	});
	return button;
}

function fieldList(fields) {
	const wrap = el('div', { className: 'fields' });
	for (const [label, value, mono] of fields) {
		if (value === undefined || value === null || value === '') continue;
		wrap.append(
			el('span', {}, [
				el('b', { textContent: `${label} ` }),
				mono ? el('code', { textContent: short(value) }) : short(value),
			]),
		);
	}
	return wrap;
}

function renderRow(row) {
	const left = el('div', {}, [el('div', { className: `title ${row.struck ? 'struck' : ''}`, textContent: row.title })]);
	for (const b of row.badges || []) left.firstChild.append(' ', badge(b.text, b.kind));
	if (row.fields?.length) left.append(fieldList(row.fields));

	const actions = el('div', { className: 'actions' });
	if (row.path) {
		const preview = el('button', { textContent: `view :${row.line || 1}`, title: `Preview ${row.path} in the panel` });
		preview.addEventListener('click', () => openPreview(row.path, row.line || 1));
		actions.append(preview);
	}
	if (row.link) {
		actions.append(
			el('a', {
				href: row.link,
				textContent: 'editor',
				title: `${row.path} — opens in VSCode. Blocked inside VSCode's Simple Browser; use "view" there.`,
			}),
		);
	}
	if (row.path) actions.append(copyButton(row.path));
	if (row.extraAction) actions.append(row.extraAction);

	const node = el('div', { className: 'row' }, [left, actions]);
	node.dataset.scope =
		(row.badges || [])
			.map((b) => SCOPE_OF_LAYER[b.text])
			.filter(Boolean)
			.join(' ') || 'both';
	node.dataset.cluster = row.cluster || '';
	node.dataset.haystack = [
		row.title,
		row.path,
		row.clusterLabel,
		...(row.badges || []).map((b) => b.text),
		...(row.fields || []).map((f) => `${f[0]} ${f[1]}`),
	]
		.join(' ')
		.toLowerCase();
	return node;
}

/** Finds the first array in a section payload, tolerating several shapes. */
function pickList(data, keys) {
	if (Array.isArray(data)) return data;
	if (!data || typeof data !== 'object') return [];
	for (const key of keys) if (Array.isArray(data[key])) return data[key];
	for (const value of Object.values(data)) if (Array.isArray(value)) return value;
	return [];
}

/**
 * Which scope a layer belongs to.
 *
 * "User" is everything outside the repo — one reality per machine, no branch:
 * ~/.claude/**, ~/.claude.json, the plugin cache, and machine-wide managed
 * policy. "Project" is the repo's tracked config plus this checkout's own
 * per-machine settings.local.json, which is the part that varies per branch and
 * per worktree.
 */
const SCOPE_OF_LAYER = {
	// Outside the repo: one reality per machine, no branch.
	enterprise: 'user',
	user: 'user',
	plugin: 'user',
	// Inside the repo: varies per branch and per worktree.
	project: 'project',
	local: 'project',
	worktree: 'project',
	// Emitted by the memory scanner. `nested` is a directory-scoped CLAUDE.md
	// and `project-symlink` is the root AGENTS.md link — both live in the repo,
	// so leaving them unmapped would leak project rows into the User view.
	nested: 'project',
	'project-symlink': 'project',
	// directives-scan reports where the directive was found
	'user-memory': 'user',
	// Codex runtime layer: per-machine session state, no branch.
	runtime: 'user',
	'project-memory': 'project',
	'nested-memory': 'project',
	rule: 'project',
	// Codex adds four more. `system` is Codex's own shipped skill set under
	// ~/.codex/skills/.system and `builtin` is a command with no file at all —
	// neither is repo-controlled, and a builtin belongs to both scopes because it
	// is present whatever tree you open. `profile` and `cli` are per-invocation
	// overrides that live in the user's config or in argv, never in the repo.
	system: 'user',
	builtin: 'both',
	profile: 'user',
	cli: 'user',
};

/**
 * A marketplace's origin as one readable line.
 *
 * `source` is a shape, not a string — `{source:'github', repo:'owner/name'}` for
 * a GitHub marketplace, other keys for other kinds — so rendering it directly
 * printed "[object Object]" where the answer to "where did this come from"
 * belonged. Unknown shapes fall back to their own JSON rather than to nothing:
 * a shape this function has not met yet is still evidence.
 */
function marketplaceOrigin(entry) {
	const source = entry?.source;
	if (!source) return null;
	if (typeof source === 'string') return source;
	if (source.source === 'github' && source.repo) return `github: ${source.repo}`;
	if (source.repo) return `${source.source || 'repo'}: ${source.repo}`;
	if (source.url) return `${source.source || 'url'}: ${source.url}`;
	if (source.path) return `local path: ${source.path}`;
	return JSON.stringify(source);
}

let activeScope = 'all';

/** A row belongs to the active scope if any of its layer badges does. */
function rowInScope(row) {
	if (activeScope === 'all') return true;
	const layers = (row.badges || []).map((b) => b.text).filter((t) => SCOPE_OF_LAYER[t]);
	if (!layers.length) return true; // rows with no layer badge are structural, never hidden
	return layers.some((layer) => SCOPE_OF_LAYER[layer] === activeScope || SCOPE_OF_LAYER[layer] === 'both');
}

/**
 * Badge colour per layer id.
 *
 * The six Claude layers use their own id as the CSS class. Codex emits four
 * more: `system` and `builtin` are shipped with the tool rather than authored
 * here, which is the same reading as `plugin`; `profile` and `cli` are overrides
 * that apply to some invocations and not others, which is a caveat rather than a
 * place, so they read as a warning.
 *
 * An id in neither list still renders — with its real name and a neutral
 * colour. Dropping it would hide a layer, and colouring it by guesswork would be
 * a claim about authority the panel has not established.
 */
const LAYER_BADGE_KIND = {
	enterprise: 'enterprise',
	user: 'user',
	project: 'project',
	local: 'local',
	worktree: 'worktree',
	plugin: 'plugin',
	system: 'plugin',
	builtin: 'plugin',
	profile: 'warn',
	cli: 'warn',
	// Codex: the latest turn_context is the effective runtime state and beats
	// every file layer for the keys it carries — green, because it is what runs.
	runtime: 'ok',
};

const layerBadge = (layer) => {
	if (!layer) return null;
	const text = String(layer);
	return { text, kind: LAYER_BADGE_KIND[text] || '' };
};

/**
 * Shortens an absolute path for display WITHOUT losing identity. Collapsing to
 * the last two segments is tempting but wrong here: this repo has four distinct
 * `.../skills_cwd/.claude/CLAUDE.md` files that would all render identically.
 */
function displayPath(absPath, ctx) {
	if (!absPath) return '(unnamed)';
	if (ctx?.projectRoot && absPath.startsWith(`${ctx.projectRoot}/`)) return absPath.slice(ctx.projectRoot.length + 1);
	if (ctx?.home && absPath.startsWith(`${ctx.home}/`)) return `~/${absPath.slice(ctx.home.length + 1)}`;
	return absPath;
}

/**
 * The directory a skill, command or subagent was scanned from: the file — and
 * for a skill, its folder — stripped off. Nested command namespaces
 * (`.claude/commands/opsx`) and each cached plugin version stay distinct.
 */
const sourceDirOf = (absPath) => String(absPath || '').replace(/\/[^/]+\/SKILL\.md$|\/[^/]+$/i, '') || '(no file)';

/** Where this workspace records its curation — shown when it has none yet. */
const curationPath = (state) =>
	state?.curation?.path ? displayPath(state.curation.path, { projectRoot: state.projectRoot, home: state.home }) : '.claude/harness-curation.json';

const INTERPRETERS = new Set([
	'bash',
	'sh',
	'zsh',
	'dash',
	'node',
	'python',
	'python3',
	'deno',
	'bun',
	'ruby',
	'perl',
	'env',
]);

/** True when the hook command hands the script to an interpreter. */
function runsViaInterpreter(command) {
	if (typeof command !== 'string') return false;
	const first =
		command
			.trim()
			.replace(/^\[.*?\]\s*(&&|\|\|)\s*/, '')
			.trim()
			.split(/\s+/)[0] || '';
	return INTERPRETERS.has(first.split('/').pop());
}

/**
 * Per-section view state: ordering, and an optional "hide what never applies"
 * filter. Skills needed this first; MCP servers, commands, subagents and hooks
 * need the same thing once usage numbers exist, so it is a registry rather than
 * four copies.
 *
 * Two different meanings of "usage" live here and the labels must keep them
 * apart. Skills and plugins carry a LIFETIME counter from ~/.claude.json. The
 * rest are counted by scanning recent session transcripts, so their number is
 * "in the last N sessions". Presenting both as a bare count would quietly
 * compare a total against a window.
 */
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const byName = (a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''));

const SECTION_VIEWS = {
	// Settings has no sort: the merge already emits keys in cascade order, and
	// what the owner reads here is "which FILE says this", so the rows are
	// bucketed by file with the path as the divider.
	settings: {
		group: {
			label: 'Group by source file',
			title:
				'One block per settings file, in cascade order (weakest first). A key sits under the file whose value wins — or, for a merged list, under the last file that contributes to it.',
			on: true,
		},
	},
	skills: {
		defaultSort: 'usage',
		group: {
			label: 'Group by cluster',
			title:
				'Buckets rows by what they are FOR, not by where they live. The active order still applies inside each group.',
			on: true,
		},
		groupFile: {
			label: 'Group by source folder',
			title:
				'Buckets rows by the directory they were scanned from — your user scope, this project, each cached plugin version. Replaces the cluster grouping while on.',
		},
		// Plugin skills are the only ones that exist five times over, because only
		// a plugin keeps every version it ever cached. Off by default this section
		// answers "what did I write", which is the question the owner asks of it;
		// tick it off and it answers "what is installed" — cached copies included.
		// The Skill listing cost card is deliberately NOT filtered by this: those
		// rows still cost context whether or not they are on screen here.
		source: {
			label: 'Only my own skills (no plugins)',
			title:
				'Shows only skills you wrote — user and project scope. Plugin skills still load and still cost context; the Skill listing card in Summary always counts them.',
			on: true,
			excludedLabel: (n) => `${n} plugin rows not shown`,
		},
		hide: {
			label: 'Hide skills that never load',
			title:
				'Hides skills switched off by skillOverrides, shadowed by a higher scope, or belonging to a disabled plugin or a stale cached plugin version.',
			on: true,
			hiddenLabel: (n) => `${n} never load — hidden`,
			shownLabel: (n) => `${n} of these never load`,
		},
		sorts: {
			usage: {
				label: 'Most used',
				hint: 'Lifetime dispatch count since install, not a recent window',
				compare: (a, b) => num(b.usageCount) - num(a.usageCount) || num(b.lastUsedAt) - num(a.lastUsedAt),
			},
			recent: {
				label: 'Recently used',
				hint: 'Last time the skill was actually dispatched',
				compare: (a, b) => num(b.lastUsedAt) - num(a.lastUsedAt) || num(b.usageCount) - num(a.usageCount),
			},
			cost: {
				label: 'Context cost',
				hint: 'Characters this skill adds to the always-resident listing',
				compare: (a, b) => num(b.listingChars) - num(a.listingChars),
			},
			name: { label: 'Name', hint: 'Alphabetical', compare: () => 0 },
		},
	},
	mcp: {
		defaultSort: 'usage',
		// Same rule as Skills: only a plugin contributes rows the owner never
		// wrote. Off by default this section answers "what did I set up", which
		// is the question asked of it; tick it off for the installed inventory.
		source: {
			label: 'Only my own MCP servers (no plugins)',
			title:
				'Shows only MCP servers you configured — user, project and local scope. Plugin MCP servers still load and still cost context; this only changes what is on screen.',
			on: true,
			excludedLabel: (n) => `${n} plugin rows not shown`,
		},
		group: {
			label: 'Group by cluster',
			title:
				'Buckets rows by what they are FOR, not by where they live. The active order still applies inside each group.',
			on: true,
		},
		sorts: {
			usage: {
				label: 'Most called',
				hint: 'Tool calls in the scanned session window',
				compare: (a, b) => num(b.calls) - num(a.calls),
			},
			name: { label: 'Name', hint: 'Alphabetical', compare: () => 0 },
		},
	},
	commands: {
		defaultSort: 'usage',
		// Same rule as Skills: only a plugin contributes rows the owner never
		// wrote. Off by default this section answers "what did I set up", which
		// is the question asked of it; tick it off for the installed inventory.
		source: {
			label: 'Only my own commands (no plugins)',
			title:
				'Shows only commands you configured — user, project and local scope. Plugin commands still load and still cost context; this only changes what is on screen.',
			on: true,
			excludedLabel: (n) => `${n} plugin rows not shown`,
		},
		group: {
			label: 'Group by cluster',
			title:
				'Buckets rows by what they are FOR, not by where they live. The active order still applies inside each group.',
			on: true,
		},
		groupFile: {
			label: 'Group by source folder',
			title:
				'Buckets rows by the directory they were scanned from — your user scope, this project, each cached plugin version. Replaces the cluster grouping while on.',
		},
		hide: {
			label: 'Hide stale cached plugin versions',
			title:
				'A plugin keeps every version it has ever cached, and each one carries a full copy of its commands. Only the active version loads; the rest are on disk and unreachable.',
			on: true,
			hiddenLabel: (n) => `${n} stale-version copies hidden`,
			shownLabel: (n) => `${n} of these are stale-version copies`,
		},
		sorts: {
			usage: {
				label: 'Most invoked',
				hint: 'Slash invocations in the scanned session window',
				compare: (a, b) => num(b.invocations) - num(a.invocations),
			},
			name: { label: 'Name', hint: 'Alphabetical', compare: () => 0 },
		},
	},
	agents: {
		defaultSort: 'usage',
		// Same rule as Skills: only a plugin contributes rows the owner never
		// wrote. Off by default this section answers "what did I set up", which
		// is the question asked of it; tick it off for the installed inventory.
		source: {
			label: 'Only my own subagents (no plugins)',
			title:
				'Shows only subagents you configured — user, project and local scope. Plugin subagents still load and still cost context; this only changes what is on screen.',
			on: true,
			excludedLabel: (n) => `${n} plugin rows not shown`,
		},
		group: {
			label: 'Group by cluster',
			title:
				'Buckets rows by what they are FOR, not by where they live. The active order still applies inside each group.',
			on: true,
		},
		groupFile: {
			label: 'Group by source folder',
			title:
				'Buckets rows by the directory they were scanned from — your user scope, this project, each cached plugin version. Replaces the cluster grouping while on.',
		},
		hide: {
			label: 'Hide stale cached plugin versions',
			title:
				'A plugin keeps every version it has ever cached, and each one carries a full copy of its agents. Only the active version loads; the rest are on disk and unreachable.',
			on: true,
			hiddenLabel: (n) => `${n} stale-version copies hidden`,
			shownLabel: (n) => `${n} of these are stale-version copies`,
		},
		sorts: {
			usage: {
				label: 'Most dispatched',
				hint: 'Subagent dispatches in the scanned session window',
				compare: (a, b) => num(b.dispatches) - num(a.dispatches),
			},
			name: { label: 'Name', hint: 'Alphabetical', compare: () => 0 },
		},
	},
	hooks: {
		defaultSort: 'cost',
		group: {
			label: 'Group by event',
			title:
				'One block per event + matcher — every PostToolUse [Edit|Write|MultiEdit] hook together, every Stop hook together. Blocks are ordered by their first row under the active order.',
			on: true,
		},
		// Same rule as Skills: only a plugin contributes rows the owner never
		// wrote. Off by default this section answers "what did I set up", which
		// is the question asked of it; tick it off for the installed inventory.
		source: {
			label: 'Only my own hooks (no plugins)',
			title:
				'Shows only hooks you configured — user, project and local scope. Plugin hooks still load and still cost context; this only changes what is on screen.',
			on: true,
			excludedLabel: (n) => `${n} plugin rows not shown`,
		},
		sorts: {
			cost: {
				label: 'Slowest × most frequent',
				hint: 'runs × median duration — what a hook actually costs you per session, not just how often it fires',
				compare: (a, b) => num(b.runs) * num(b.p50Ms) - num(a.runs) * num(a.p50Ms),
			},
			usage: {
				label: 'Most runs',
				hint: 'Executions in the scanned session window',
				compare: (a, b) => num(b.runs) - num(a.runs),
			},
			slow: {
				label: 'Slowest median',
				hint: 'Median duration per execution',
				compare: (a, b) => num(b.p50Ms) - num(a.p50Ms),
			},
			name: { label: 'Event', hint: 'Alphabetical', compare: () => 0 },
		},
	},
	injected: {
		defaultSort: 'recent',
		group: {
			label: 'Group by hook',
			title: 'One block per hook, so twenty firings of the same SessionStart hook read as one hook with a count.',
			on: true,
		},
		// This section is a LOG, not an inventory: every capture is one hook firing
		// in one past session, and the scanner reads twenty transcripts. The same
		// handful of hooks therefore appears twenty times over, which is the same
		// repetition the plugin filter cures elsewhere -- by session here, since a
		// capture has no plugin to come from.
		source: {
			label: 'Only the latest session',
			title:
				'Keeps the captures from the most recent transcript. The rest are real, and they are history: the same hooks firing in earlier sessions, not context injected now.',
			on: true,
			excludes: (capture) => capture?.latestSession !== true,
			excludedLabel: (n) => `${n} from earlier sessions`,
		},
		hide: {
			label: 'Hide captures that injected nothing',
			title:
				'A hook that ran and returned no text added nothing to the context. It is worth knowing it fired, and it is not injected context.',
			on: true,
			hiddenLabel: (n) => `${n} injected nothing — hidden`,
			shownLabel: (n) => `${n} of these injected nothing`,
		},
		sorts: {
			recent: {
				label: 'Most recent',
				hint: 'When the hook fired, newest first',
				compare: (a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')),
			},
			cost: {
				label: 'Largest',
				hint: 'Bytes the hook added to the context',
				compare: (a, b) => num(b.bytes) - num(a.bytes),
			},
			name: { label: 'Hook', hint: 'Alphabetical by hook name', compare: () => 0 },
		},
	},
	directives: {
		defaultSort: 'severity',
		group: {
			label: 'Group by source file',
			title:
				'One block per file the directives were read from. Blocks are ordered by their first row under the active order, so "strongest first" puts the file with the strongest directive on top.',
			on: true,
		},
		// 222 of 253 directives here do not govern the current session: a nested
		// CLAUDE.md only loads while you work inside its directory, and a rule
		// loads when the task reaches for it. Listing them beside the 31 that are
		// always in context made the section read as 253 standing orders.
		source: {
			label: 'Only what always loads',
			title:
				'Keeps the directives that are in context for every turn — your user and project CLAUDE.md. Hides nested CLAUDE.md files, which apply only while you work inside their directory, and shared rules, which load when the task calls for them.',
			on: true,
			excludes: (directive) => directive?.alwaysLoaded !== true,
			excludedLabel: (n) => `${n} load only in context`,
		},
		sorts: {
			severity: {
				label: 'Strongest first',
				hint: 'Prohibitions before requirements before cautions',
				compare: (a, b) => severityRank(b) - severityRank(a),
			},
			name: { label: 'Source file', hint: 'Alphabetical by the file it came from', compare: () => 0 },
		},
	},
	rules: {
		defaultSort: 'cost',
		group: {
			label: 'Group by folder',
			title: 'One block per directory the rule files live in, folders alphabetical. The active order still applies inside each block.',
			on: true,
		},
		sorts: {
			cost: {
				label: 'Largest',
				hint: 'Bytes — rules have no dispatch event, so size is cost, not usage',
				compare: (a, b) => num(b.bytes) - num(a.bytes),
			},
			name: { label: 'Name', hint: 'Alphabetical', compare: () => 0 },
		},
	},
	plugins: {
		defaultSort: 'cost',
		hide: {
			label: 'Hide disabled plugins',
			title:
				'A disabled plugin is installed on disk but contributes nothing to a session — no skills, no commands, no agents, no MCP servers, no hooks. Untick to see what is installed but switched off.',
			on: true,
			hiddenLabel: (n) => `${n} disabled — hidden`,
			shownLabel: (n) => `${n} of these are disabled`,
		},
		sorts: {
			cost: {
				label: 'Most context',
				hint: 'Estimated tokens the plugin adds to a session listing — only enabled plugins spend any',
				compare: (a, b) => num(b.estimatedTokens) - num(a.estimatedTokens),
			},
			name: { label: 'Name', hint: 'Alphabetical', compare: () => 0 },
		},
	},
};

const viewState = {};
for (const [id, spec] of Object.entries(SECTION_VIEWS)) {
	// `collapsed` is a Set of cluster ids the owner folded shut. It has to live
	// here and not on the DOM: every filter keystroke re-renders the section, and
	// a group that springs back open on each keystroke is unusable.
	viewState[id] = {
		sort: spec.defaultSort,
		hide: spec.hide?.on === true,
		group: spec.group?.on === true,
		groupFile: spec.groupFile?.on === true,
		source: spec.source?.on === true,
		collapsed: new Set(),
	};
}

/**
 * Whether a plugin contributed this row.
 *
 * `scope` is the MCP scanner's name for what every other scanner calls `layer`;
 * one helper reading both keeps the source filter a single rule instead of five
 * that can drift apart.
 */
/** Prohibition outranks requirement outranks caution; anything else sorts last. */
function severityRank(directive) {
	return { prohibition: 3, requirement: 2, caution: 1 }[directive?.severity] ?? 0;
}

function fromPlugin(row) {
	return (row?.layer ?? row?.scope) === 'plugin';
}

/**
 * Drops plugin-contributed rows when the section's source filter is on, and
 * records how many went — the heading has to say so rather than let a row count
 * quietly shrink.
 *
 * Runs BEFORE applyView so every count downstream describes the same set of
 * rows: filtering afterwards would leave the heading counting one population
 * and the list showing another.
 */
function applySourceFilter(id, items) {
	const state = viewState[id];
	if (!SECTION_VIEWS[id]?.source || !state) return items;
	// Most sections filter out what a plugin contributed. Directives have no
	// plugin origin at all -- their noise is directives that exist but do not
	// govern the session -- so a section may name its own rule instead.
	const excludes = SECTION_VIEWS[id].source.excludes ?? fromPlugin;
	const kept = state.source ? items.filter((item) => !excludes(item)) : items;
	state.excludedBySource = items.length - kept.length;
	return kept;
}

/** Applies the active ordering (and hide filter) for a section. */
function applyView(id, items, hidePredicate) {
	const spec = SECTION_VIEWS[id];
	if (!spec) return items;
	const state = viewState[id];
	// Counted whether or not the filter is on: with it OFF the heading still has
	// to say how many of the rows on screen never load, or a row count that is
	// honest about the disk reads as a claim about the session.
	state.neverLoadCount = typeof hidePredicate === 'function' ? items.filter((item) => !hidePredicate(item)).length : 0;
	const kept = state.hide && typeof hidePredicate === 'function' ? items.filter(hidePredicate) : items;
	const compare = (spec.sorts[state.sort] || spec.sorts.name).compare;
	return [...kept].sort((a, b) => compare(a, b) || byName(a, b));
}

function sectionControls(id, onChange) {
	const spec = SECTION_VIEWS[id];
	if (!spec) return null;
	const state = viewState[id];
	const bar = el('div', { className: 'section-controls' });

	if (spec.group) {
		const groupId = `${id}-group`;
		const checkbox = el('input', { type: 'checkbox', id: groupId, checked: state.group });
		checkbox.addEventListener('change', () => {
			state.group = checkbox.checked;
			if (checkbox.checked) state.groupFile = false;
			onChange();
		});
		bar.append(checkbox, el('label', { htmlFor: groupId, textContent: spec.group.label, title: spec.group.title }));
	}

	if (spec.groupFile) {
		const fileId = `${id}-group-file`;
		const checkbox = el('input', { type: 'checkbox', id: fileId, checked: state.groupFile });
		checkbox.addEventListener('change', () => {
			state.groupFile = checkbox.checked;
			if (checkbox.checked) state.group = false;
			onChange();
		});
		bar.append(checkbox, el('label', { htmlFor: fileId, textContent: spec.groupFile.label, title: spec.groupFile.title }));
	}

	if (spec.source) {
		const sourceId = `${id}-source-filter`;
		const checkbox = el('input', { type: 'checkbox', id: sourceId, checked: state.source });
		checkbox.addEventListener('change', () => {
			state.source = checkbox.checked;
			onChange();
		});
		bar.append(checkbox, el('label', { htmlFor: sourceId, textContent: spec.source.label, title: spec.source.title }));
	}

	if (spec.hide) {
		const toggleId = `${id}-hide`;
		const checkbox = el('input', { type: 'checkbox', id: toggleId, checked: state.hide });
		checkbox.addEventListener('change', () => {
			state.hide = checkbox.checked;
			onChange();
		});
		bar.append(checkbox, el('label', { htmlFor: toggleId, textContent: spec.hide.label, title: spec.hide.title }));
	}

	if (!spec.sorts) return bar;
	const select = el('select', { title: spec.sorts[state.sort].hint });
	for (const [value, sort] of Object.entries(spec.sorts)) {
		const option = el('option', { value, textContent: sort.label });
		if (value === state.sort) option.selected = true;
		select.append(option);
	}
	select.addEventListener('change', () => {
		state.sort = select.value;
		onChange();
	});
	bar.append(el('span', { className: 'ctl-label', textContent: 'Order' }), select);
	bar.append(el('span', { className: 'ctl-hint', textContent: spec.sorts[state.sort].hint }));
	return bar;
}

/**
 * Carries the server-stamped cluster from the scanned item onto the rendered
 * row. Defaults are deliberate: an item the server could not classify reads as
 * `unclassified` with source `none`, never as a plausible-looking guess.
 */
const clusterFields = (item) => ({
	cluster: item?.cluster ?? 'unclassified',
	clusterLabel: item?.clusterLabel ?? 'Unclassified',
	clusterOrder: Number.isFinite(item?.clusterOrder) ? item.clusterOrder : Number.MAX_SAFE_INTEGER,
	clusterSource: item?.clusterSource ?? 'none',
});

/** Exec-policy verdicts, from "fine" to "never". */
const DECISION_KIND = { allow: 'ok', prompt: 'warn', forbidden: 'bad' };

const ADAPTERS = {
	memory(data, ctx) {
		return pickList(data, ['entries', 'chain', 'files']).map((entry) => ({
			title: displayPath(entry.path, ctx),
			path: entry.path,
			line: 1,
			link: entry.link,
			badges: [
				layerBadge(entry.layer),
				entry.alwaysInjected ? { text: 'always injected', kind: 'ok' } : { text: 'on demand', kind: 'warn' },
				entry.isSymlink ? { text: 'symlink', kind: 'plugin' } : null,
				entry.tripsLargeFileWarning ? { text: 'large file', kind: 'bad' } : null,
			].filter(Boolean),
			fields: [
				['bytes', entry.bytes],
				['est. tokens', entry.estimatedTokens],
				['symlink →', entry.symlinkTarget, true],
				['error', entry.error],
			],
		}));
	},

	/**
	 * One row per settings key, whichever harness produced it.
	 *
	 * `winningLayer` and every `perLayer[].layer` go through layerBadge and the
	 * per-layer field labels, so Codex's extra cascade steps — a `[profiles.*]`
	 * table, a `-c` override on the command line, a project-level config.toml —
	 * render exactly like `user` or `local` do here, with no branch of their own.
	 */
	settings(data, ctx) {
		// Cascade position of every source file, so the groups read weakest ->
		// strongest exactly as the merge resolves them. A layer with no file on
		// disk (Codex's runtime turn_context, a `-c` flag) is keyed by layer id.
		const fileKey = (path, layer) => path ?? `layer:${layer}`;
		const cascade = new Map((data?.layers ?? []).map((layer, i) => [fileKey(layer.path, layer.id), i]));
		return pickList(data, ['keys']).map((key) => {
			// A union key (a permission list, a hook registration) has NO winning
			// layer: every layer's entries are live at once. `winningLayer` is null
			// there by design, so the deep link falls back to the last layer that
			// contributed — a real file that really carries part of the value —
			// rather than leaving the row unlinkable.
			const union = key.mergeKind === 'union';
			const sourceLayer = key.winningLayer ?? key.contributingLayers?.at(-1);
			// A key can have no winner AND no contributor: every layer that
			// defines it is inert (a profile that is not selected). Falling back
			// to the first layer that defines it at all keeps the row from
			// rendering with no provenance whatsoever — and files it under that
			// layer's file instead of an "unsourced" bucket.
			const source = key.perLayer?.find((l) => l.layer === sourceLayer) ?? (key.perLayer ?? [])[0];
			const contributors = key.contributingLayers || [];
			const cluster = fileKey(source?.path, source?.layer);
			return {
				title: key.key,
				path: source?.path,
				line: source?.line,
				link: source?.link,
				cluster,
				clusterLabel: source?.path ? displayPath(source.path, ctx) : `${source?.layer ?? 'unknown'} — no file on disk`,
				clusterOrder: cascade.get(cluster) ?? Number.MAX_SAFE_INTEGER,
				clusterKind: 'literal',
				clusterBadge: layerBadge(source?.layer),
				badges: [
					layerBadge(source?.layer),
					key.winningLayer == null && !union && (key.perLayer ?? []).some((entry) => entry.ignored)
						? { text: 'defined but inert', kind: 'warn' }
						: null,
					union && contributors.length ? { text: `merged from ${contributors.join(' + ')}`, kind: 'ok' } : null,
					key.known === false ? { text: 'unknown key', kind: 'bad' } : null,
					key.ownerOnly || OWNER_ONLY.test(key.key) ? { text: 'owner-only — do not change', kind: 'owner' } : null,
					key.secret ? { text: 'masked', kind: 'warn' } : null,
					// Several layers holding a union key is cooperation, not conflict:
					// nothing is being overridden, so the warning would be a false alarm.
					!union && (key.perLayer || []).length > 1 ? { text: 'conflict', kind: 'warn' } : null,
				].filter(Boolean),
				fields: [
					[union ? 'effective (union of every layer)' : 'effective', key.effectiveValue, true],
					...(key.perLayer || []).map((l) => [
						`${l.layer}${
							l.ignored ? ' (ignored)' : union && l.contributes ? ' (contributes)' : l.overridden ? ' (overridden)' : ''
						}`,
						`${short(l.value, 70)}${l.ignoredReason ? ` — ${l.ignoredReason}` : ''}`,
						true,
					]),
				],
			};
		});
	},

	hooks(data) {
		const eventOf = (hook) => `${hook.event}${hook.matcher && hook.matcher !== '*' ? ` [${hook.matcher}]` : ''}`;
		// hook.line points into the settings file that REGISTERS the hook; when
		// the row opens the script instead, that line number is noise.
		const lineOf = (hook) => (hook.scriptPath ? 1 : hook.line);
		// Group order follows the active sort: the block whose first row ranks
		// highest comes first, so "slowest × most frequent" still reads top-down.
		const firstSeen = new Map();
		return applyView('hooks', applySourceFilter('hooks', pickList(data, ['hooks', 'rows']))).map((hook, i) => ({
			title: eventOf(hook),
			// Under an event header the event is already said; the script is what
			// tells three PostToolUse rows apart.
			groupedTitle: hook.scriptPath ? hook.scriptPath.split('/').pop() : short(hook.command, 80),
			cluster: eventOf(hook),
			clusterLabel: eventOf(hook),
			clusterOrder: firstSeen.get(eventOf(hook)) ?? (firstSeen.set(eventOf(hook), i), i),
			clusterKind: 'literal',
			path: hook.scriptPath || hook.sourcePath,
			line: lineOf(hook),
			link: hook.link,
			badges: [
				layerBadge(hook.layer),
				// Only claim a script is missing when one was actually identified. A
				// hook whose command is inline (`echo ...`, a shell pipeline) has no
				// script to miss, and badging it 'script missing' is the panel
				// inventing a broken file out of an unanswered question.
				hook.scriptPath && hook.scriptExists === false ? { text: 'script missing', kind: 'bad' } : null,
				!hook.scriptPath ? { text: 'inline command', kind: 'plugin' } : null,
				// The exec bit only matters when the command runs the file itself.
				// `python3 x.py` and `bash x.sh` work fine on a mode-644 file, so
				// warning there would be a false alarm on a perfectly healthy hook.
				hook.scriptExists && hook.scriptExecutable === false && !runsViaInterpreter(hook.command)
					? { text: 'not executable', kind: 'bad' }
					: null,
				hook.escapeHatches?.length ? { text: 'escape hatch', kind: 'warn' } : null,
				bypassBadgeFor(hook.scriptPath || hook.command),
				// Codex records a hash of each hook script it was told to trust. A
				// mismatch means the file changed since then, which is the one hook
				// fact worth shouting about. Claude hooks carry no such field, so
				// `undefined` deliberately renders neither badge.
				hook.trusted === false ? { text: 'untrusted — hash mismatch', kind: 'bad' } : null,
				hook.trusted === true ? { text: 'trusted', kind: 'ok' } : null,
				// The number is now scoped to what this row's matcher could have
				// produced, so it is stated plainly and the `attribution` field says
				// how wide that scope is. `null` runs means no bucket matched at
				// all — a real "not observed", never a zero.
				hook.runs == null
					? { text: 'no runs recorded', kind: 'plugin' }
					: { text: `${hook.runs} runs`, kind: hook.runs > 0 ? 'ok' : 'plugin' },
				// Latency on a blocking hook is spent on every tool call or prompt,
				// so it is the number that actually costs the user time.
				hook.p50Ms == null
					? null
					: {
							text: `${hook.p50Ms}ms median`,
							kind: hook.blocking && hook.p50Ms > 2000 ? 'bad' : hook.p50Ms > 500 ? 'warn' : 'ok',
						},
				hook.timedOut ? { text: `${hook.timedOut} timed out`, kind: 'bad' } : null,
			].filter(Boolean),
			fields: [
				hook.runs != null && hook.p50Ms != null
					? ['cost per window', `${hook.runs} runs × ${hook.p50Ms}ms ≈ ${Math.round((hook.runs * hook.p50Ms) / 1000)}s`]
					: ['timing', hook.timingScope || 'no runs recorded in the scanned window'],
				['attribution', hook.runs == null ? null : hook.timingScope],
				['blocking', hook.blocking === true ? 'yes — runs on every matching call' : 'no'],
				['slowest run', hook.maxMs != null ? `${hook.maxMs}ms` : null],
				['plugin', hook.plugin ? `${hook.plugin} ${hook.pluginVersion ?? ''}`.trim() : null],
				['command', hook.command, true],
				['script', hook.scriptPath, true],
				['error', hook.scriptError],
			],
		}));
	},

	skills(data, ctx) {
		const all = applySourceFilter('skills', pickList(data, ['skills']));
		const loads = (skill) => {
			if (skill.state === 'off' || skill.state === 'user-invocable-only') return false;
			if (skill.shadowedBy) return false;
			if (skill.layer !== 'plugin') return true;
			// Same rule as commands and agents: a skill in a stale cached version
			// is on disk and unreachable. The scanner's own tag answers this; the
			// enabled-plugin path check below is a separate question (the plugin
			// may be disabled outright), so both have to pass.
			if (skill.activeVersion === false) return false;
			return (ctx?.activePluginPaths ?? []).some((base) => String(skill.path || '').startsWith(`${base}/`));
		};
		return applyView('skills', all, loads).map((skill) => ({
			...clusterFields(skill),
			title: skill.qualifiedName || skill.name,
			path: skill.path,
			line: skill.line || 1,
			link: skill.link,
			struck: skill.state === 'off',
			badges: [
				// Leading with the number: the owner could not tell usage order from
				// alphabetical order at a glance, because the count was buried in the
				// small grey field row underneath.
				skill.usageKnown
					? { text: `${skill.usageCount || 0}×`, kind: skill.usageCount > 0 ? 'ok' : 'plugin' }
					: { text: 'no counter', kind: 'plugin' },
				layerBadge(skill.layer),
				skill.state && skill.state !== 'on'
					? { text: skill.state, kind: skill.state === 'off' ? 'off' : 'warn' }
					: null,
				skill.shadowedBy ? { text: `shadowed by ${skill.shadowedBy}`, kind: 'warn' } : null,
				skill.activeVersion === false ? { text: 'stale cached version', kind: 'off' } : null,
			].filter(Boolean),
			fields: [
				['uses', skill.usageKnown ? `${skill.usageCount || 0} since install` : 'no counter'],
				['last used', skill.lastUsedAt ? new Date(skill.lastUsedAt).toISOString().slice(0, 10) : 'never'],
				['description', short(skill.description, 110)],
				['listing chars', skill.listingChars],
				['plugin version', skill.pluginVersion],
				['state from', skill.stateSource, true],
			],
		}));
	},

	commands(data) {
		// `activeVersion === false` is a plugin command sitting in a stale cached
		// version: really on disk, and unable to load. The scanner keeps the row —
		// it reports what is there — and the view decides whether to show it.
		const loads = (command) => command.activeVersion !== false;
		return applyView('commands', applySourceFilter('commands', pickList(data, ['commands'])), loads).map((command) => ({
			...clusterFields(command),
			title: `/${command.name}`,
			path: command.path,
			line: 1,
			link: command.link,
			badges: [
				command.invocations == null
					? null
					: { text: `${command.invocations}×`, kind: command.invocations > 0 ? 'ok' : 'plugin' },
				layerBadge(command.layer),
				command.activeVersion === false ? { text: 'stale cached version', kind: 'off' } : null,
				command.disableModelInvocation ? { text: 'user-typed only', kind: 'warn' } : null,
			].filter(Boolean),
			fields: [
				['description', short(command.description, 130)],
				['allowed tools', command.allowedTools],
				['plugin version', command.pluginVersion],
			],
		}));
	},

	agents(data) {
		// Same rule as commands: a plugin agent in a stale cached version is on
		// disk and unreachable. Five cached versions of one plugin produced five
		// identical rows, which read as five agents rather than one.
		const loads = (agent) => agent.activeVersion !== false;
		return applyView('agents', applySourceFilter('agents', pickList(data, ['agents'])), loads).map((agent) => ({
			...clusterFields(agent),
			title: agent.name,
			path: agent.path,
			line: agent.line || 1,
			link: agent.link,
			badges: [
				layerBadge(agent.layer),
				agent.activeVersion === false ? { text: 'stale cached version', kind: 'off' } : null,
				agent.valid === false ? { text: 'never loads', kind: 'bad' } : null,
			].filter(Boolean),
			fields: [
				['model', agent.model],
				['tools', Array.isArray(agent.tools) ? agent.tools.join(', ') : agent.tools],
				['description', short(agent.description, 110)],
				['plugin version', agent.pluginVersion],
				['invalid', agent.invalidReason],
			],
		}));
	},

	mcp(data, ctx) {
		return applyView('mcp', applySourceFilter('mcp', pickList(data, ['servers']))).map((server) => ({
			...clusterFields(server),
			title: server.name,
			path: server.sourcePath,
			line: server.line,
			link: server.link,
			struck: server.disabled === true,
			badges: [
				// `null` calls means the harness cannot attribute them (a Codex rollout
				// hides calls routed through its `exec` aggregator). Saying so beats
				// both a silent row and a zero that would read as "never used".
				server.calls == null
					? ctx?.usageUnknown?.has('mcpServers')
						? { text: 'calls not attributable', kind: 'plugin' }
						: null
					: { text: `${server.calls} calls`, kind: server.calls > 0 ? 'ok' : 'plugin' },
				// `account/client` is not one of the config layers, so it renders in
				// the neutral colour LAYER_BADGE_KIND falls back to. That is the
				// honest reading: it names where the server comes from without
				// claiming a place in a cascade it never entered.
				layerBadge(server.scope),
				// A profile overlay is real configuration that is NOT in effect unless
				// the profile is selected, so it must never read plain 'enabled'.
				server.configured === false
					? { text: 'no config today — usage only', kind: 'warn' }
					: server.ignored
						? { text: server.ignoredReason || 'inert unless its profile is selected', kind: 'warn' }
						: server.disabled
							? { text: 'disabled', kind: 'off' }
							: { text: 'enabled', kind: 'ok' },
				server.needsAuth === true ? { text: 'needs auth (cached)', kind: 'warn' } : null,
			].filter(Boolean),
			fields: [
				['description', server.description],
				['transport', server.transport],
				['normalized', server.normalizedName, true],
				['command', server.command, true],
				['url', server.url, true],
				['env keys', (server.envKeys || []).join(', ')],
				['disabled by', server.disabledSource, true],
				['auth cache mtime', server.authCacheMtime],
			],
		}));
	},

	directives(data, ctx) {
		const firstSeen = new Map();
		return applyView('directives', applySourceFilter('directives', pickList(data, ['directives']))).map(
			(directive, i) => ({
				title: directive.text,
				path: directive.sourcePath,
				cluster: directive.sourcePath || '(no file)',
				clusterLabel: displayPath(directive.sourcePath, ctx),
				clusterOrder: firstSeen.get(directive.sourcePath) ?? (firstSeen.set(directive.sourcePath, i), i),
				clusterKind: 'literal',
				clusterBadge: directive.alwaysLoaded ? { text: 'always loaded', kind: 'ok' } : { text: 'on demand', kind: 'warn' },
				line: directive.line,
				link: directive.link,
				badges: [
					{
						text: directive.severity || 'directive',
						kind:
							directive.severity === 'prohibition' ? 'bad' : directive.severity === 'requirement' ? 'warn' : 'plugin',
					},
					directive.alwaysLoaded ? { text: 'always loaded', kind: 'ok' } : { text: 'on demand', kind: 'warn' },
					directive.language === 'pt' ? { text: 'pt', kind: 'plugin' } : null,
				].filter(Boolean),
				fields: [
					['keyword', directive.keyword],
					['source', displayPath(directive.sourcePath, ctx), true],
					['heading', directive.heading],
				],
			}),
		);
	},

	rules(data, ctx) {
		const dirOf = (p) => String(p || '').replace(/\/[^/]*$/, '') || '(no folder)';
		return applyView('rules', pickList(data, ['rules'])).map((rule) => ({
			title: rule.name || rule.title,
			path: rule.path,
			cluster: dirOf(rule.path),
			clusterLabel: displayPath(dirOf(rule.path), ctx),
			clusterKind: 'literal',
			line: rule.line || 1,
			link: rule.link,
			badges: [
				// Rules have no dispatch event, so there is no usage to show. Size is
				// the honest number here, labelled as cost rather than relevance.
				rule.bytes == null ? null : { text: `${Math.round(rule.bytes / 1024)}KB`, kind: 'plugin' },
				rule.mandatory ? { text: 'mandatory', kind: 'ok' } : { text: 'optional', kind: 'warn' },
				rule.citedExplicitly ? { text: 'cited', kind: 'project' } : null,
			].filter(Boolean),
			fields: [
				['title', rule.title],
				['bytes', rule.bytes],
				['referenced by', (rule.referencedBy || []).map((r) => `${r.file}:${r.line}`).join(', '), true],
			],
		}));
	},

	/**
	 * Codex exec policy: which command patterns the sandbox allows, prompts on,
	 * or refuses outright (`~/.codex/rules/*.rules`).
	 *
	 * Claude Code has no counterpart — its equivalent decisions are permission
	 * rules inside settings, and they render in the settings section. So this is
	 * the one adapter with no Claude reading, and it exists because a forbidden
	 * pattern the owner cannot see is a guard they will assume they have.
	 */
	execpolicy(data) {
		return pickList(data, ['rules', 'policies', 'entries']).map((rule) => ({
			title: Array.isArray(rule.pattern) ? rule.pattern.join(' ') : short(rule.pattern) || '(no pattern)',
			path: rule.path,
			line: rule.line,
			link: rule.link,
			badges: [
				{ text: rule.decision || 'unknown', kind: DECISION_KIND[rule.decision] || '' },
				layerBadge(rule.layer),
			].filter(Boolean),
			fields: [
				['file', rule.path, true],
				['note', rule.note],
			],
		}));
	},

	plugins(data) {
		// The row already carried the marketplace NAME, which is a folder under
		// ~/.claude/plugins/repos and says nothing about where the code came from.
		// The marketplace list in this same payload knows the actual origin, so
		// join them and put the repo on the row instead of one screen away.
		const originOf = new Map(
			(Array.isArray(data?.marketplaces) ? data.marketplaces : []).map((entry) => [
				entry.name,
				marketplaceOrigin(entry),
			]),
		);
		const loads = (plugin) => plugin.enabled !== false;
		return applyView('plugins', pickList(data, ['plugins']), loads).map((plugin) => ({
			title: plugin.key || plugin.name,
			path: plugin.path,
			line: plugin.enabledLine || 1,
			link: plugin.enabledLink,
			struck: plugin.enabled === false,
			badges: [
				// 'disabled' is a decision someone made; a plugin absent from the config
				// was never decided about. Saying so keeps the row from claiming an
				// intent the file does not record.
				plugin.enabled
					? { text: 'enabled', kind: 'ok' }
					: /not in config/i.test(String(plugin.enabledSource || ''))
						? { text: 'not in config', kind: 'warn' }
						: { text: 'disabled', kind: 'off' },
				{ text: plugin.marketplace || 'local', kind: 'plugin' },
			],
			fields: [
				['version', plugin.version],
				[
					'came from',
					originOf.get(plugin.marketplace) ||
						(plugin.marketplace
							? `${plugin.marketplace} — no upstream recorded, see Source marketplaces below`
							: 'no marketplace recorded'),
				],
				['skills', plugin.contributes?.skills?.length],
				['commands', plugin.contributes?.commands?.length],
				['agents', plugin.contributes?.agents?.length],
				['mcp', plugin.contributes?.mcpServers?.length],
				['hooks', plugin.contributes?.hooks],
				['est. tokens', plugin.estimatedTokens],
				['enabled by', plugin.enabledSource, true],
			],
		}));
	},

	worktrees(data, ctx) {
		return pickList(data, ['worktrees']).map((tree) => ({
			title: displayPath(tree.path, ctx),
			path: tree.settingsPath,
			line: 1,
			link: tree.link,
			badges: [
				tree.isMain ? { text: 'main checkout', kind: 'project' } : null,
				tree.driftKind === 'same'
					? { text: 'in sync', kind: 'ok' }
					: { text: tree.driftKind || 'unknown', kind: 'warn' },
			].filter(Boolean),
			fields: [
				['branch', tree.branch],
				['sha256', tree.sha256 ? `${String(tree.sha256).slice(0, 12)}…` : null, true],
				['bytes', tree.bytes],
				['error', tree.error],
			],
		}));
	},

	injected(data, ctx) {
		const rows = [];
		// Codex has no hooks provenance in its rollouts and records its base
		// instructions, so the Claude wording would be a lie there.
		const codex = ctx?.harness === 'codex';
		if (data?.baseSystemPrompt?.available) {
			rows.push({
				title: codex ? 'Recorded base instructions (session_meta)' : 'Base Claude Code system prompt',
				badges: [
					data.baseSystemPrompt.available
						? { text: codex ? 'from rollout — incomplete by design' : 'from transcript', kind: 'warn' }
						: { text: 'not exposed by the harness', kind: 'warn' },
				],
				fields: [['why', data.baseSystemPrompt.reason]],
			});
		}
		if (data?.outputStyle) {
			rows.push({
				title: codex
					? data.outputStyle.name || 'Turn context'
					: `Output style: ${data.outputStyle.name || '(default)'}`,
				path: data.outputStyle.path,
				line: data.outputStyle.line || 1,
				link: data.outputStyle.link,
				badges: [data.outputStyle.exists ? { text: 'active', kind: 'ok' } : { text: 'absent', kind: 'warn' }],
				fields: [['bytes', data.outputStyle.content?.length]],
				cluster: 'output-style',
				clusterLabel: 'Output style',
				clusterOrder: -1,
				clusterKind: 'literal',
			});
		}
		// Both capture lists are filtered and ordered as ONE population: they are
		// the same kind of event, and sorting them separately would put a stale
		// SessionStart above a fresh UserPromptSubmit purely because of which
		// array it came from.
		const captures = [];
		for (const [key, label] of [
			['sessionStartOutput', codex ? 'Injected at session start' : 'SessionStart'],
			['userPromptSubmitOutput', codex ? 'Injected per turn' : 'UserPromptSubmit'],
		]) {
			for (const capture of data?.[key] || []) captures.push({ ...capture, label });
		}
		// "Latest session" is the transcript holding the newest capture, not the
		// newest file on disk: a session that ran but fired no hook injected
		// nothing, and calling it the latest would empty the section.
		const newest = captures.reduce(
			(best, capture) => (!best || String(capture.capturedAt) > String(best.capturedAt) ? capture : best),
			null,
		);
		for (const capture of captures) capture.latestSession = capture.transcriptPath === newest?.transcriptPath;

		const injectedSomething = (capture) => num(capture.bytes) > 0;
		const firstSeen = new Map();
		const kept = applyView('injected', applySourceFilter('injected', captures), injectedSomething);
		kept.forEach((capture, i) => {
			// The same hookName covers every script on the event; the first line
			// of the output is what tells them apart.
			const head = String(capture.text || '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 80);
			const hook = `${capture.label}: ${capture.hookName || '(unnamed)'}${head ? ` — ${head}` : ''}`;
			rows.push({
				title: hook,
				groupedTitle: `${capture.bytes ?? 0} bytes — ${capture.capturedAt ?? ''}`,
				cluster: hook,
				clusterLabel: hook,
				clusterOrder: firstSeen.get(hook) ?? (firstSeen.set(hook, i), i),
				clusterKind: 'literal',
				path: capture.transcriptPath,
				line: 1,
				badges: [
					{ text: codex ? 'from rollout' : 'from transcript', kind: 'plugin' },
					capture.latestSession ? { text: 'this session', kind: 'ok' } : null,
					injectedSomething(capture) ? null : { text: 'injected nothing', kind: 'off' },
					capture.truncated ? { text: 'truncated', kind: 'warn' } : null,
				].filter(Boolean),
				fields: [
					['captured at', capture.capturedAt],
					['duration ms', capture.durationMs],
					['bytes', capture.bytes],
					['text', short(capture.text, 220), true],
				],
			});
		});
		return rows;
	},
};

function genericRows(data) {
	const list = pickList(data, []);
	if (list.length) {
		return list.map((item, i) => ({
			title: item?.name || item?.key || item?.id || `item ${i + 1}`,
			path: item?.path,
			line: item?.line || 1,
			link: item?.link,
			badges: [],
			fields: Object.entries(item || {})
				.filter(([k]) => !['path', 'link', 'line'].includes(k))
				.slice(0, 8)
				.map(([k, v]) => [k, short(v, 90), true]),
		}));
	}
	return [];
}

/**
 * Buckets already-ordered rows into cluster groups.
 *
 * Ordering is NOT recomputed here: `applyView` has already applied whatever the
 * owner picked (most used, context cost, name), and partitioning preserves it,
 * so "most used" inside Diagnosis still means most used. Groups themselves are
 * laid out by `clusterOrder` — the server's pipeline order — so the section
 * reads discovery -> spec -> plan -> build -> verify -> ship rather than
 * alphabetically.
 */
function clusterGroupsOf(rows) {
	const groups = new Map();
	for (const row of rows) {
		const key = row.cluster || 'unclassified';
		if (!groups.has(key)) {
			groups.set(key, {
				id: key,
				label: row.clusterLabel || 'Unclassified',
				order: Number.isFinite(row.clusterOrder) ? row.clusterOrder : Number.MAX_SAFE_INTEGER,
				rows: [],
				family: 0,
				none: 0,
				kind: row.clusterKind ?? null,
				badge: row.clusterBadge ?? null,
			});
		}
		const group = groups.get(key);
		group.rows.push(row);
		if (row.clusterSource === 'family') group.family += 1;
		if (row.clusterSource === 'none') group.none += 1;
	}
	return [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/**
 * One collapsible cluster group.
 *
 * The header says where its labels came from. A cluster whose members were
 * matched by a `plugin:*` family rule is a weaker claim than one curated by
 * name, and the panel says so once per group instead of tattooing every row —
 * the same reason the hidden-row count lives on the heading and not on 181 rows.
 */
function renderClusterGroup(group, state, triggerOf) {
	const details = el('details', { className: 'cluster-group' });
	if (group.kind) details.classList.add(`cluster-group--${group.kind}`);
	details.dataset.cluster = group.id;
	details.open = !state.collapsed.has(group.id);

	const count = badge(String(group.rows.length), 'plugin');
	count.classList.add('cluster-count');
	const name = el('span', { className: 'cluster-name', textContent: group.label });
	const summary = el('summary', {}, [name, group.badge ? badge(group.badge.text, group.badge.kind) : null, count]);
	if (group.family > 0) summary.append(badge(`${group.family} by family rule`, 'warn'));
	const trigger = triggerOf(group.id);
	if (trigger) summary.append(el('span', { className: 'cluster-trigger', textContent: trigger }));
	details.append(summary);

	details.addEventListener('toggle', () => {
		if (details.open) state.collapsed.delete(group.id);
		else state.collapsed.add(group.id);
	});
	return details;
}

function renderSection(id, label, payload, ctx) {
	const card = el('section', { className: 'card', id: `section-${id}` });
	const heading = el('h2', {}, [label]);
	// A card read on its own (or screenshotted) must still say whose harness it
	// inventories; the header at the top of the page scrolls away.
	heading.append(badge(harnessLabel(ctx?.harness ?? activeHarness), 'harness'));
	card.append(heading);
	const body = el('div', { className: 'section-body' });

	if (!payload) {
		body.append(el('div', { className: 'note', textContent: 'no data returned' }));
		card.append(body);
		return { card, count: 0 };
	}

	if (payload.ok === false) {
		body.append(
			el('div', { className: 'error-box' }, [
				el('div', {
					textContent: 'This section could not be read. The panel reports the real error rather than inventing data.',
				}),
				el('div', { className: 'path', textContent: payload.modulePath || '' }),
				el('pre', { className: 'body', textContent: payload.error || 'unknown error' }),
			]),
		);
		heading.append(badge('error', 'bad'));
		card.append(body);
		return { card, count: 0 };
	}

	const data = payload.data;
	let rows = [];
	try {
		rows = (ADAPTERS[id] || genericRows)(data, ctx) || [];
	} catch (error) {
		rows = [];
		body.append(el('div', { className: 'error-box' }, [`renderer failed: ${error?.message || error}`]));
	}
	if (!rows.length) rows = genericRows(data);

	const countBadge = badge(`${rows.length} rows`, 'ok');
	countBadge.classList.add('row-count');
	heading.append(countBadge);
	card.dataset.total = String(rows.length);

	if (SECTION_VIEWS[id]) {
		// Say plainly how many rows a filter is holding back — a hidden count with
		// no number is how a panel starts lying by omission.
		const source = Array.isArray(data)
			? data
			: (data?.[id] ??
				data?.skills ??
				data?.servers ??
				data?.commands ??
				data?.agents ??
				data?.hooks ??
				data?.rules ??
				[]);
		// `neverLoadCount` is measured on the rows this view is actually about, so
		// it stays right when a source filter has already removed some of them;
		// the raw source length would fold two different filters into one number.
		const hiddenCount = viewState[id].neverLoadCount ?? (Array.isArray(source) ? source.length - rows.length : 0);
		if (viewState[id].excludedBySource > 0) {
			const label = SECTION_VIEWS[id].source?.excludedLabel ?? ((n) => `${n} not shown`);
			heading.append(badge(label(viewState[id].excludedBySource), 'plugin'));
		}
		if (viewState[id].hide && hiddenCount > 0) {
			// Each section says WHY its rows are held back: "never load" is right
			// for a skill switched off by an override, and wrong for a plugin
			// command that exists five times over in five cached versions.
			const label = SECTION_VIEWS[id].hide?.hiddenLabel ?? ((n) => `${n} hidden`);
			heading.append(badge(label(hiddenCount), 'off'));
		} else if (!viewState[id].hide && viewState[id].neverLoadCount > 0) {
			// Filter off: the row count is now a disk count, and on its own it
			// reads as "this harness has 243 skills". It does not — it has 243
			// files. Say so on the same line as the number, not in another card.
			const label = SECTION_VIEWS[id].hide?.shownLabel ?? ((n) => `${n} of these never load`);
			heading.append(badge(label(viewState[id].neverLoadCount), 'off'));
		}
		const controls = sectionControls(id, () => render({ force: false }));
		if (controls) body.append(controls);

		// A cluster with nothing in it is a real finding — a stage of the work
		// this workspace has no tool for. Saying it costs one line; leaving it
		// implicit means the gap is only visible to someone who already knows
		// the eleven clusters by heart. The server only sends this for the kinds
		// where an empty cluster is actionable (see lib/taxonomy.mjs).
		const gaps = Array.isArray(payload.clusterGaps) ? payload.clusterGaps : [];
		if (viewState[id].group && gaps.length) {
			const named = gaps.map((gap) => ctx?.clusterById?.get(gap)?.label || gap).join(', ');
			body.append(
				el('div', {
					className: 'note',
					textContent: `No row here covers: ${named}. Empty clusters are shown as gaps, not hidden.`,
				}),
			);
		}
	}

	const byFile = SECTION_VIEWS[id]?.groupFile && viewState[id]?.groupFile;
	if (byFile) {
		// The cluster is still worth reading per row once it no longer heads a
		// block, same as the ungrouped branch below.
		rows = rows.map((row) => ({
			...row,
			badges: row.clusterLabel ? [...(row.badges || []), { text: row.clusterLabel, kind: 'plugin' }] : row.badges,
			cluster: sourceDirOf(row.path),
			clusterLabel: displayPath(sourceDirOf(row.path), ctx),
			clusterOrder: Number.MAX_SAFE_INTEGER,
			clusterKind: 'literal',
			clusterSource: 'file',
			clusterBadge: null,
		}));
	}
	const grouped = byFile || (SECTION_VIEWS[id]?.group && viewState[id]?.group && rows.some((row) => row.cluster));
	if (grouped) {
		const state = viewState[id];
		const triggerOf = (clusterId) => ctx?.clusterById?.get(clusterId)?.trigger || '';
		for (const group of clusterGroupsOf(rows)) {
			const node = renderClusterGroup(group, state, triggerOf);
			for (const row of group.rows) node.append(renderRow({ ...row, title: row.groupedTitle ?? row.title }));
			body.append(node);
		}
	} else {
		for (const row of rows) {
			// Ungrouped, the cluster still has to be readable — otherwise turning
			// the toggle off silently destroys the information.
			if (row.cluster && row.clusterLabel) {
				row.badges = [...(row.badges || []), { text: row.clusterLabel, kind: 'plugin' }];
			}
			body.append(renderRow(row));
		}
	}
	// Section-level findings that are not rows but matter. These used to be
	// dumped as raw JSON, which is not an explanation — the owner read the
	// duplicates block and could not tell what it was asking of them. Each one
	// now says what it means and whether it needs action.
	const NOTE_KINDS = {
		orphanOverrides: {
			title: 'Dead overrides',
			why: 'These names match no installed skill, so the override silently does nothing. Usually a typo or a skill that was removed.',
			row: (item) => ({
				title: item.name,
				path: item.path,
				line: item.line,
				link: item.link,
				badges: [{ text: 'matches no skill', kind: 'bad' }],
				fields: [['declared in', item.layer]],
			}),
		},
		duplicates: {
			title: 'Same skill name in two scopes',
			why: 'The project copy wins and the user copy is inert HERE — but the user copy is what makes the skill exist in your other projects, so deleting it is usually wrong. The risk is silent drift: editing the shadowed copy changes nothing in this repo. While they stay identical there is nothing to do.',
			row: (item) => ({
				title: item.name,
				badges: [
					{ text: (item.layers || []).join(' + '), kind: 'warn' },
					item.identical ? { text: 'in sync — no action', kind: 'ok' } : { text: 'DIVERGED — pick one', kind: 'bad' },
				],
				fields: [['project copy wins', 'the user copy is ignored in this repo']],
			}),
		},
		collisions: {
			title: 'Name collisions in one directory',
			why: 'Two definitions share a name in the same folder. One is discarded silently and which one survives follows unsorted directory order, so it can differ between machines.',
			row: (item) => ({
				title: item.name || String(item),
				badges: [{ text: 'nondeterministic winner', kind: 'bad' }],
				fields: [],
			}),
		},
		marketplaces: {
			title: 'Source marketplaces',
			why: 'A marketplace is the catalogue a plugin was installed FROM — not a plugin itself. Each one is a repo cloned under ~/.claude/plugins/repos/. "Listed in settings" means your settings.json names it under extraKnownMarketplaces, so Claude Code can offer new plugins from it; "on disk only" means the clone exists but nothing declares it, so it still serves the plugins already installed and offers nothing new.',
			row: (item) => ({
				title: item.name,
				path: item.path,
				line: 1,
				badges: [
					item.source
						? { text: 'listed in settings', kind: 'ok' }
						: item.foundVia === 'installed-plugin'
							? { text: 'ships with Claude Code', kind: 'plugin' }
							: { text: 'on disk only — not in settings', kind: 'warn' },
					item.servesPlugins ? { text: `${item.servesPlugins} installed`, kind: 'ok' } : null,
				].filter(Boolean),
				fields: [
					[
						'upstream',
						marketplaceOrigin(item) ||
							(item.foundVia === 'installed-plugin'
								? 'not fetched from anywhere — it comes with the CLI'
								: 'nothing declares where this clone came from'),
					],
					['clone', item.path, true],
				],
			}),
		},
	};
	// Section-level notes: things worth saying that are not entries of the
	// section. A note never becomes a row, so it cannot inflate the count.
	for (const note of Array.isArray(data?.notes) ? data.notes : []) {
		body.append(el('div', { className: 'note', textContent: String(note) }));
	}

	for (const [key, spec] of Object.entries(NOTE_KINDS)) {
		const extra = data?.[key];
		if (!Array.isArray(extra) || !extra.length) continue;
		// The title gets its own ruled line rather than riding inside the grey
		// note: these rows are a different list from the section's own, and a
		// label that looks like a caption made them read as more of the same.
		body.append(
			el('div', { className: 'subsection' }, [
				el('span', { className: 'subsection-title', textContent: spec.title }),
				el('span', { className: 'subsection-count', textContent: `${extra.length}` }),
			]),
		);
		body.append(el('div', { className: 'note', textContent: spec.why }));
		for (const item of extra) {
			try {
				// Findings are commentary on the section, not entries of it. They
				// must not inflate the "shown of total" arithmetic, which is how the
				// heading ended up claiming "134 of 132".
				const node = renderRow(spec.row(item));
				node.classList.add('finding');
				body.append(node);
			} catch {
				body.append(el('div', { className: 'note', textContent: JSON.stringify(item) }));
			}
		}
	}

	if (!rows.length) body.append(el('div', { className: 'note', textContent: 'nothing found for this family' }));

	card.append(body);
	return { card, count: rows.length };
}

/**
 * The curated bypass map is the one thing no scanner can derive: a verified hole
 * in a guard, with the date somebody checked it. It is workspace DATA, read from
 * `.claude/harness-curation.json` by the server (lib/curation.mjs) — never a
 * constant in this file, which would make every other workspace's table read
 * "audited and clean" when it means "nobody has looked".
 *
 * Each entry is compiled once here. An entry whose `match` will not compile is
 * dropped rather than allowed to throw mid-render; the server already warns.
 */
let activeBypasses = [];
const bypassBadgeFor = (name) =>
	activeBypasses.some((entry) => entry.matcher && entry.matcher.test(String(name || '')))
		? { text: 'known bypass', kind: 'bad' }
		: null;

function compileBypasses(curation) {
	const out = [];
	for (const entry of curation?.bypasses ?? []) {
		let matcher = null;
		if (typeof entry.match === 'string') {
			try {
				matcher = new RegExp(entry.match);
			} catch {
				continue;
			}
		}
		out.push({ ...entry, matcher });
	}
	return out;
}

/**
 * Collects every guardrail the scanners already found into three enforcement
 * layers. Pure composition over state.sections — no new endpoint, and a section
 * that failed simply contributes nothing rather than faking rows.
 */
function collectGuardrails(state, ctx, bypasses = []) {
	const bypassOf = (name) => bypasses.find((b) => b.matcher && b.matcher.test(String(name || '')));
	const codex = ctx.harness === 'codex';
	const sections = state.sections ?? {};
	const listOf = (id, keys) => {
		const payload = sections[id];
		return payload?.ok ? pickList(payload.data, keys) : [];
	};
	const hooks = listOf('hooks', ['hooks', 'rows']);
	const keys = listOf('settings', ['keys']);
	const directives = listOf('directives', ['directives']);
	const execRules = listOf('execpolicy', ['rules', 'policies', 'entries']);
	const keyByName = new Map(keys.map((key) => [key.key, key]));
	const rulesIn = (key) => {
		const value = key?.effectiveValue;
		return Array.isArray(value) ? value.length : value == null ? 0 : 1;
	};
	const scriptName = (hook) => (hook.scriptPath ? hook.scriptPath.split('/').pop() : short(hook.command, 40));

	const mech = [];
	const asks = [];
	const intent = [];
	const row = (list, entry) => list.push(entry);

	// --- hooks (Claude): a blocking hook on a pre-execution event is a wall;
	// PostToolUse runs after the fact, so it observes whatever it says.
	const GATE_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse']);
	// A Stop hook gates the turn's end by its exit code, but the scanner marks
	// only per-call hooks as blocking — so Stop is included by event, not flag.
	const gateHooks = hooks.filter(
		(hook) => (hook.blocking === true && GATE_EVENTS.has(hook.event)) || hook.event === 'Stop',
	);
	// Only PostToolUse hooks are "after the fact" observers of a tool call;
	// SessionStart and friends belong to other moments and would inflate it.
	const observers = hooks.filter((hook) => hook.event === 'PostToolUse');
	for (const hook of gateHooks) {
		const name = scriptName(hook);
		const bypass = bypassOf(name);
		row(mech, {
			title: name,
			event: hook.event,
			gateMeta: `${hook.matcher && hook.matcher !== '*' ? hook.matcher : 'all'}${hook.runs > 0 ? ` · ${hook.runs} runs` : ''}`,
			path: hook.scriptPath || hook.sourcePath,
			line: hook.scriptPath ? 1 : hook.line,
			link: hook.link,
			badges: [
				{ text: `${hook.event}${hook.matcher && hook.matcher !== '*' ? ` [${hook.matcher}]` : ''}`, kind: 'ok' },
				layerBadge(hook.layer),
				hook.runs > 0 ? { text: `${hook.runs} runs`, kind: 'plugin' } : null,
				bypass ? { text: 'known bypass', kind: 'bad' } : null,
				hook.escapeHatches?.length ? { text: 'escape hatch', kind: 'warn' } : null,
			].filter(Boolean),
			fields: [['command', hook.command, true]],
			target: ['hooks', name],
			bypass,
		});
	}

	// --- permission keys (Claude): deny walls, ask gates. Missing keys simply
	// do not appear — a zero-rule guard is stated on the pipeline, not faked here.
	const SETTING_GUARDS = [
		['permissions.deny', mech, 'denies'],
		['autoMode.soft_deny', mech, 'denies in auto mode'],
		['permissions.additionalDirectories', mech, 'write boundary'],
		['permissions.ask', asks, 'asks first'],
		['permissions.defaultMode', asks, 'permission mode'],
	];
	for (const [name, list, why] of SETTING_GUARDS) {
		const key = keyByName.get(name);
		if (!key) continue;
		const source = key.perLayer?.find((l) => l.layer === (key.winningLayer ?? key.contributingLayers?.at(-1))) ?? key.perLayer?.[0];
		row(list, {
			title: name,
			path: source?.path,
			line: source?.line,
			link: source?.link,
			badges: [
				{ text: `${rulesIn(key)} rule${rulesIn(key) === 1 ? '' : 's'}`, kind: list === mech ? 'ok' : 'warn' },
				layerBadge(source?.layer),
			].filter(Boolean),
			fields: [[why, short(key.effectiveValue, 160), true]],
			target: ['settings', name],
		});
	}

	// --- Codex: exec policy verdicts, sandbox and approval config. A sandbox
	// switched to danger-full-access is reported as the absence it is.
	if (codex) {
		for (const decision of ['forbidden', 'prompt']) {
			const rules = execRules.filter((rule) => rule.decision === decision);
			if (!rules.length) continue;
			row(decision === 'forbidden' ? mech : asks, {
				title: `exec policy — ${decision}`,
				path: rules[0].path,
				line: rules[0].line,
				link: rules[0].link,
				badges: [{ text: `${rules.length} patterns`, kind: decision === 'forbidden' ? 'ok' : 'warn' }],
				fields: [['first', short(rules[0].pattern, 120), true]],
				target: ['execpolicy', decision],
			});
		}
		const sandbox = keyByName.get('sandbox_mode');
		if (sandbox) {
			const off = /danger/.test(String(sandbox.effectiveValue));
			row(mech, {
				title: 'sandbox_mode',
				badges: [
					off ? { text: `${sandbox.effectiveValue} — no guard`, kind: 'bad' } : { text: String(sandbox.effectiveValue), kind: 'ok' },
					off ? { text: 'not counted as a gate', kind: 'off' } : null,
				].filter(Boolean),
				fields: [],
				target: ['settings', 'sandbox_mode'],
				off,
			});
		}
		const approval = keyByName.get('approval_policy');
		if (approval) {
			const never = String(approval.effectiveValue) === 'never';
			row(asks, {
				title: 'approval_policy',
				badges: [
					never ? { text: 'never — never asks', kind: 'bad' } : { text: String(approval.effectiveValue), kind: 'warn' },
					never ? { text: 'not counted as a gate', kind: 'off' } : null,
				].filter(Boolean),
				fields: [],
				target: ['settings', 'approval_policy'],
				off: never,
			});
		}
	}

	// --- intent layer: always-loaded prohibitions. What is not in context is
	// not guarding anything right now, so on-demand files stay out (their toggle
	// lives in the Directives section).
	for (const directive of directives.filter((d) => d.severity === 'prohibition' && d.alwaysLoaded)) {
		row(intent, {
			title: directive.text,
			path: directive.sourcePath,
			line: directive.line,
			link: directive.link,
			badges: [{ text: 'prohibition', kind: 'bad' }, { text: 'always loaded', kind: 'ok' }],
			fields: [],
			target: ['directives', 'prohibition'],
		});
	}

	return {
		codex,
		mech,
		asks,
		intent,
		observers,
		hooks: { gateHooks, observers },
		scriptName,
		execAllow: execRules.filter((rule) => rule.decision === 'allow').length,
	};
}

/**
 * One pipeline gate box. kind: mech | asks | intent | observe | hole.
 * Clicking highlights the rows that define the gate INSIDE the landing —
 * jumping to another section mid-diagram read proved disorienting.
 */
function gateBox(gate, reveal) {
	const box = el('div', { className: `gr-gate ${gate.kind}${gate.bypass ? ' bypass' : ''}` }, [
		el('b', { textContent: gate.label }),
		gate.meta ? el('div', { className: 'meta', textContent: gate.meta }) : null,
	]);
	if (gate.rows?.length) {
		box.tabIndex = 0;
		box.title = 'Highlight the rows that define this gate (click again to clear)';
		const open = () => reveal(gate.rows, box, gate.kind);
		box.addEventListener('click', open);
		box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
	}
	return box;
}

/**
 * The Guardrails landing card: tiles, the turn pipeline, one block per
 * enforcement layer, and the curated bypass table. Every number on it is a row
 * someone can click through to — the diagram is an index, not a poster.
 */
function renderGuardrailsCard(state, ctx) {
	const curation = state.curation ?? null;
	const bypasses = activeBypasses;
	const g = collectGuardrails(state, ctx, bypasses);
	const card = el('section', { className: 'card', id: 'section-guardrails' });
	// No row-count badge and no nav count: this is a dashboard, not a listing,
	// and "33 rows" was a number nobody could act on.
	const heading = el('h2', {}, ['Guardrails', badge(harnessLabel(ctx.harness), 'harness')]);
	card.append(heading);
	const body = el('div', { className: 'section-body' });

	const bypassRows = [...g.mech, ...g.asks].filter((r) => r.bypass).map((r) => r.bypass);
	const bypassEntries = [...new Set([...bypassRows, ...bypasses.filter((b) => b.standalone)])];

	// --- layer blocks first (the pipeline's gates point INTO them), rendered
	// with the same cluster-group chrome every other section has.
	const nodeOf = new Map();
	const layerBlocks = [];
	const activeIn = (rows) => rows.filter((r) => !r.off).length;
	const layers = [
		['Layer 1 — mechanical', g.mech, 'really blocks', 'ok', g.codex ? 'blocking hooks + forbidden patterns + sandbox' : 'blocking hooks + deny rules + boundaries'],
		['Layer 2 — asks first', g.asks, 'friction, not a wall', 'warn', g.codex ? 'prompt patterns + approval policy' : 'ask rules + permission mode'],
		['Layer 3 — intent', g.intent, 'text, no enforcement', '', 'always-loaded NEVER directives'],
	];
	for (const [label, rows, why, kind, hint] of layers) {
		const details = el('details', { className: 'cluster-group cluster-group--literal', open: rows !== g.intent });
		const count = badge(String(rows.length), 'plugin');
		count.classList.add('cluster-count');
		details.append(
			el('summary', {}, [
				el('span', { className: 'cluster-name', textContent: label }),
				badge(why, kind),
				// A listed-but-switched-off guard (sandbox on danger, approval
				// never) counts as a row, not a gate; say so where it differs.
				activeIn(rows) !== rows.length ? badge(`${activeIn(rows)} active gates`, 'off') : null,
				count,
				el('span', { className: 'cluster-trigger', textContent: hint }),
			]),
		);
		for (const r of rows) {
			const node = renderRow(r);
			nodeOf.set(r, node);
			details.append(node);
		}
		if (!rows.length) details.append(el('div', { className: 'note', textContent: 'nothing in this layer — a gap, not a blank' }));
		layerBlocks.push(details);
	}

	// --- known bypasses as a fourth collapsible block, so the tile's count has
	// the same kind of detail behind it as the other three.
	const bypassBlock = el('details', { className: 'cluster-group cluster-group--literal', open: true });
	{
		const count = badge(String(bypassEntries.length), 'plugin');
		count.classList.add('cluster-count');
		bypassBlock.append(
			el('summary', {}, [
				el('span', { className: 'cluster-name', textContent: 'Known bypasses' }),
				badge(bypassEntries.length ? 'holes, not guards' : 'nothing recorded', bypassEntries.length ? 'bad' : 'off'),
				count,
				el('span', { className: 'cluster-trigger', textContent: 'curated map with verification dates — a guardrail without its known hole is one you only think you have' }),
			]),
		);
		if (bypassEntries.length) {
			const table = el('table', { className: 'gr-bypass' });
			table.append(el('tr', {}, [el('th', { textContent: 'Guard' }), el('th', { textContent: 'Bypass' }), el('th', { textContent: 'Verified' })]));
			for (const b of bypassEntries) {
				table.append(el('tr', {}, [el('td', {}, [el('b', { textContent: b.guard })]), el('td', { textContent: b.text }), el('td', { className: 'verified', textContent: b.verified })]));
			}
			bypassBlock.append(table);
		} else {
			// The load-bearing sentence of this whole section. An empty bypass
			// table looks exactly like a clean audit, and it is not one: it is the
			// absence of an audit. Say which, and say where to record one.
			bypassBlock.append(
				el('div', { className: 'note' }, [
					'No bypass has been recorded for this workspace. That is not the same as having none — a guard nobody has probed reads exactly like a guard with no holes. Record what you verify in ',
					el('code', { textContent: curationPath(state) }),
					' (see the project README for the shape).',
				]),
			);
		}
		if (curation?.error) {
			bypassBlock.append(el('div', { className: 'error-box', textContent: `${curationPath(state)} could not be read: ${curation.error}` }));
		}
		for (const warning of curation?.warnings ?? []) {
			bypassBlock.append(el('div', { className: 'note', textContent: `Curation warning: ${warning}` }));
		}
	}

	// --- reveal: highlight a gate's defining rows inside THIS card. Clicking a
	// second time (or another gate) clears/replaces the highlight.
	let litGate = null;
	const HIT_KINDS = ['gr-hit--mech', 'gr-hit--asks', 'gr-hit--intent', 'gr-hit--hole'];
	const reveal = (rows, box, kind) => {
		for (const node of nodeOf.values()) node.classList.remove('gr-hit', ...HIT_KINDS);
		for (const gate of card.querySelectorAll('.gr-gate.lit')) gate.classList.remove('lit');
		if (litGate === box) {
			litGate = null;
			return;
		}
		litGate = box;
		box.classList.add('lit');
		// The highlight wears the clicked gate's own color, so the eye carries
		// one hue from the diagram down to the rows it names.
		const hitKind = HIT_KINDS.includes(`gr-hit--${kind}`) ? `gr-hit--${kind}` : null;
		let first = null;
		for (const r of rows) {
			const node = nodeOf.get(r);
			if (!node) continue;
			node.classList.add('gr-hit');
			if (hitKind) node.classList.add(hitKind);
			node.closest('details')?.setAttribute('open', '');
			first ??= node;
		}
		// Instant, not smooth: the click also moves focus onto the gate, and the
		// focus scroll cancels an in-flight smooth scroll — the page never moved.
		first?.scrollIntoView({ block: 'center' });
	};

	// --- pipeline. Every gate carries the layer rows that define it, so a
	// click stays on this page.
	const stage = (phase, gates) => ({ phase, gates: gates.length ? gates : [{ label: 'no guard', kind: 'hole' }] });
	const hookGates = (event) =>
		g.mech
			.filter((r) => r.event === event)
			.map((r) => ({
				label: r.title,
				meta: r.gateMeta,
				kind: 'mech',
				bypass: !!r.bypass || r.badges.some((b) => b.text === 'escape hatch'),
				rows: [r],
			}));
	const permGate = (names, kind, label) => {
		const rows = [...g.mech, ...g.asks].filter((r) => names.includes(r.title));
		if (!rows.length) return [];
		return [{ label, meta: rows.map((r) => `${r.title.split('.').pop()} ${r.badges[0]?.text ?? ''}`).join(' · '), kind, rows }];
	};
	const intentGate = g.intent.length
		? [{ label: `${g.intent.length} prohibitions`, meta: `${g.codex ? 'AGENTS' : 'CLAUDE'}.md — no enforcement`, kind: 'intent', bypass: true, rows: g.intent }]
		: [];
	// Codex 0.149+ runs the same lifecycle hooks Claude does, so both pipelines
	// carry the hook stages; Codex adds its approval/exec-policy/sandbox gates.
	const execGates = [
		...g.mech.filter((r) => r.title.startsWith('exec policy')).map((r) => ({ label: r.title, meta: r.badges[0]?.text, kind: 'mech', rows: [r] })),
		...g.asks.filter((r) => r.title.startsWith('exec policy')).map((r) => ({ label: r.title, meta: r.badges[0]?.text, kind: 'asks', rows: [r] })),
	];
	const configGate = (title, list) =>
		list
			.filter((r) => r.title === title)
			.map((r) => ({ label: title, meta: String(r.badges[0]?.text ?? ''), kind: r.off ? 'hole' : list === g.mech ? 'mech' : 'asks', rows: [r] }));
	const stages = g.codex
		? [
				stage('Prompt', [{ label: 'user input', meta: 'turn starts', kind: 'observe' }]),
				stage('UserPromptSubmit', hookGates('UserPromptSubmit')),
				stage('Model', intentGate),
				stage('PreToolUse', hookGates('PreToolUse')),
				stage('Approval', configGate('approval_policy', g.asks)),
				stage('Exec policy', execGates.length ? execGates : [{ label: 'no guard', meta: `${g.execAllow} allow patterns, none forbidden`, kind: 'hole' }]),
				stage('Sandbox', configGate('sandbox_mode', g.mech)),
				stage('Execution', [{ label: 'tool runs', kind: 'observe' }]),
				stage('Stop', hookGates('Stop')),
			]
		: [
				stage('Prompt', [{ label: 'user input', meta: 'turn starts', kind: 'observe' }]),
				stage('UserPromptSubmit', hookGates('UserPromptSubmit')),
				stage('Model', intentGate),
				stage('PreToolUse', hookGates('PreToolUse')),
				stage('Permissions', [
					...permGate(['permissions.deny', 'autoMode.soft_deny', 'permissions.additionalDirectories'], 'mech', 'deny rules'),
					...permGate(['permissions.ask', 'permissions.defaultMode'], 'asks', 'ask rules'),
				]),
				stage('Execution', [{ label: 'tool runs', kind: 'observe' }]),
				stage('PostToolUse', [{ label: `${g.hooks.observers.length} observers`, meta: 'after the fact — see Hooks', kind: 'observe' }]),
				stage('Stop', hookGates('Stop')),
			];
	const pipe = el('div', { className: 'gr-pipe' });
	for (const st of stages) {
		pipe.append(
			el('div', { className: 'gr-stage' }, [
				el('div', { className: 'phase', textContent: st.phase }),
				...st.gates.map((gate) => gateBox(gate, reveal)),
			]),
		);
	}
	body.append(el('div', { className: 'gr-pipe-scroll' }, [pipe]));
	body.append(
		el('div', { className: 'gr-legend' }, [
			el('span', { className: 'l-mech' }, [el('i'), 'mechanical — blocks']),
			el('span', { className: 'l-asks' }, [el('i'), 'asks first']),
			el('span', { className: 'l-intent' }, [el('i'), 'intent — text only']),
			el('span', { className: 'l-hole' }, [el('i'), 'no guard / switched off']),
			el('span', { className: 'l-bypass' }, [el('i'), 'known bypass — click a gate to highlight its rows below']),
		]),
	);

	body.append(...layerBlocks, bypassBlock);
	body.append(
		el('div', {
			className: 'note',
			textContent:
				'Workspace-level guards live outside this harness and are not inventoried here: the pre-commit owner-queue gate, gitleaks in bm-vault-sync, and enforceContributorOwnership() in ez_backend.',
		}),
	);

	card.append(body);
	return { card, count: null };
}

function renderConflicts(state) {
	const settings = state.sections?.settings;
	const conflicts = settings?.ok ? settings.data?.conflicts || [] : [];
	const rows = conflicts.map((key) => ({
		title: key.key,
		path: key.perLayer?.find((l) => l.layer === key.winningLayer)?.path,
		line: key.perLayer?.find((l) => l.layer === key.winningLayer)?.line,
		link: key.perLayer?.find((l) => l.layer === key.winningLayer)?.link,
		badges: [layerBadge(key.winningLayer), { text: `${key.perLayer?.length || 0} layers`, kind: 'warn' }].filter(
			Boolean,
		),
		fields: (key.perLayer || []).map((l) => [
			`${l.layer}${l.overridden ? ' — overridden' : ' — WINS'}`,
			short(l.value, 80),
			true,
		]),
	}));
	const card = el('section', { className: 'card', id: 'section-conflicts' });
	const conflictBadge = badge(`${rows.length} keys`, rows.length ? 'warn' : 'ok');
	conflictBadge.classList.add('row-count');
	card.append(el('h2', {}, ['Conflicts', conflictBadge]));
	card.dataset.total = String(rows.length);
	const body = el('div', { className: 'section-body' });
	body.append(
		el('div', {
			className: 'note',
			textContent:
				"Keys where one layer's value replaces another's. Precedence is user < project < local, with enterprise " +
				'managed policy over all three. Union-merged keys (permission lists, hook registrations) are listed in ' +
				"Settings — every layer's entries are live.",
		}),
	);
	for (const row of rows) body.append(renderRow(row));
	if (!rows.length)
		body.append(el('div', { className: 'note', textContent: 'no key is defined in more than one layer' }));
	card.append(body);
	return { card, count: rows.length };
}

const nav = document.getElementById('nav');
const main = document.getElementById('main');
const status = document.getElementById('status');
const search = document.getElementById('search');
let active = 'guardrails';

/** The landing shows the harness identity, its resident cost, and its guards. */
const LANDING_CARDS = new Set(['section-guardrails', 'section-source', 'section-summary']);

function applyFilter() {
	const needle = search.value.trim().toLowerCase();
	let visible = 0;
	for (const row of main.querySelectorAll('.row')) {
		const scopeOk =
			activeScope === 'all' || row.dataset.scope === 'both' || (row.dataset.scope || '').includes(activeScope);
		const hit = scopeOk && (!needle || (row.dataset.haystack || '').includes(needle));
		row.classList.toggle('hidden', !hit);
		if (hit) visible += 1;
	}
	// A group header left standing over zero visible rows is the same lie as a
	// nav count that never moves, so groups follow their rows.
	for (const group of main.querySelectorAll('details.cluster-group')) {
		const total = group.querySelectorAll('.row').length;
		const shown = group.querySelectorAll('.row:not(.hidden)').length;
		// Only a group that HAS rows and lost them all to the filter goes away.
		// A group made of something else (the bypass table) is not empty, and
		// hiding it because it holds zero .row nodes erased it permanently.
		group.classList.toggle('hidden', total > 0 && shown === 0);
		// A rowless group (the bypass table) keeps its own count — rewriting it
		// from a .row census would relabel 3 curated entries as 0.
		if (total === 0) continue;
		const count = group.querySelector('.cluster-count');
		if (count) count.textContent = shown === total ? String(total) : `${shown} of ${total}`;
	}

	for (const card of main.querySelectorAll('section.card')) {
		const shown = card.querySelectorAll('.row:not(.hidden):not(.finding)').length;
		// A typed needle searches the whole harness, not the active section —
		// the old "All families" view survives as this expansion.
		const isActive = needle
			? true
			: active === 'guardrails'
				? LANDING_CARDS.has(card.id)
				: !active || card.id === `section-${active}`;
		card.classList.toggle('hidden', !isActive || (needle && shown === 0));

		// The nav count must track the filter. A sidebar that keeps saying 15
		// while one row is on screen is the panel lying about its own state.
		const id = card.id.replace(/^section-/, '');
		const button = nav.querySelector(`button[data-id="${id}"] .count`);
		if (button)
			button.textContent =
				card.dataset.total && shown !== Number(card.dataset.total) ? `${shown}/${card.dataset.total}` : String(shown);
		const heading = card.querySelector('h2 .row-count');
		if (heading)
			heading.textContent =
				card.dataset.total && shown !== Number(card.dataset.total)
					? `${shown} of ${card.dataset.total} rows`
					: `${shown} rows`;
	}
	if (needle || activeScope !== 'all') status.textContent = `${visible} rows shown`;
}

function selectSection(id) {
	active = id;
	for (const button of nav.querySelectorAll('button'))
		button.setAttribute('aria-current', String(button.dataset.id === id));
	applyFilter();
}

let activeRoot = null;

/**
 * On first load the panel points at the repo's MAIN checkout rather than the
 * directory it was launched from. That is the anchor reality — the branch every
 * other worktree derives from — and it is what someone opening the panel cold
 * expects to see. Selecting another working tree is one click away.
 */
async function pickDefaultRoot() {
	if (activeRoot) return;
	try {
		const response = await fetch('/api/roots');
		const payload = await response.json();
		const main = (payload.roots || []).find((entry) => entry && entry.isMain);
		if (main) activeRoot = main.path;
	} catch {
		// no roots endpoint: fall back to the launch root, which the server uses
	}
}

async function render({ force = false } = {}) {
	await pickDefaultRoot();
	status.textContent = `reading ${harnessLabel(activeHarness)} config…`;
	let state;
	try {
		const query = apiQuery();
		if (force) query.set('force', '1');
		const response = await fetch(`/api/state?${query}`);
		state = await response.json();
		// The server refuses a harness it does not have rather than answering with
		// the other one. Say so instead of rendering an empty panel.
		if (!response.ok || state?.error) {
			status.textContent = state?.error || `HTTP ${response.status}`;
			main.replaceChildren(
				el('div', {
					className: 'error-box',
					textContent: `${state?.error || `HTTP ${response.status}`}${
						Array.isArray(state?.known) ? ` — known harnesses: ${state.known.join(', ')}` : ''
					}`,
				}),
			);
			return;
		}
	} catch (error) {
		status.textContent = 'failed to read';
		main.replaceChildren(
			el('div', {
				className: 'error-box',
				textContent: `Could not reach the panel server: ${error?.message || error}`,
			}),
		);
		return;
	}

	// The build the SERVER is on, remembered the first time this page saw it.
	// `Refresh` re-reads config from disk; it does not re-fetch this file. So a
	// tab left open across a panel restart keeps running the OLD app.js against
	// the NEW server and renders yesterday's labels over today's data — which is
	// exactly the kind of quiet staleness this panel exists to catch. Compare and
	// say so; the reader decides when to reload.
	if (loadedBuild === null) loadedBuild = state.build ?? null;
	const staleCode = loadedBuild !== null && state.build != null && state.build !== loadedBuild;

	lastState = state;
	main.replaceChildren();
	nav.replaceChildren();

	const pluginsData = state.sections?.plugins?.ok ? state.sections.plugins.data : null;
	const pluginList = Array.isArray(pluginsData) ? pluginsData : (pluginsData?.plugins ?? []);
	const ctx = {
		// Which harness these rows describe; adapters that must not reuse Claude
		// wording for Codex branch on it.
		harness: state.meta?.harness?.id ?? activeHarness,
		// Dimensions this harness cannot count. A row that says nothing beats a
		// row that says zero; a row that says WHY beats both.
		usageUnknown: new Set([...(state.usage?.untracked ?? []), ...(state.usage?.partial ?? [])]),
		home: state.home,
		projectRoot: state.projectRoot,
		// Same rule the server uses for the cost headline: a skill only loads if
		// its plugin is enabled AND it sits under that plugin's active cached
		// version. Filtering by `state: off` alone let skills from a disabled
		// plugin top the "context cost" order while never entering context.
		activePluginPaths: pluginList
			.filter((plugin) => plugin.enabled)
			.map((plugin) => plugin.path)
			.filter(Boolean),
		// Trigger sentences for the group headers. Only `/api/state` carries this;
		// the rows themselves carry their own label and order, so a section-only
		// refresh degrades to headers without the one-line trigger, not to headers
		// that cannot name themselves.
		clusterById: new Map((state.meta?.clusters ?? []).map((cluster) => [cluster.id, cluster])),
	};

	// Which tree these facts came from. The panel reads the WORKING TREE, not the
	// anchor branch, because that is what governs the running session — and most
	// of what it reads has no branch at all. Divergence is shown, not hidden.
	const g = state.git;
	if (g) {
		const card = el('section', { className: 'card', id: 'section-source' });
		const diverging = g.divergingFiles || [];
		card.append(
			el('h2', {}, [
				'Source of truth',
				badge(g.available ? g.branch || 'detached' : 'not a git repo', g.available ? 'project' : 'bad'),
				g.isMainWorktree ? badge('main checkout', 'ok') : badge('worktree', 'warn'),
				diverging.length
					? badge(`${diverging.length} config file(s) differ from ${g.anchorRef}`, 'warn')
					: badge(`config matches ${g.anchorRef}`, 'ok'),
			]),
		);
		const body = el('div', { className: 'section-body' });
		body.append(
			renderRow({
				title: displayPath(state.projectRoot, ctx) || state.projectRoot,
				path: state.projectRoot,
				badges: [],
				fields: [
					['branch', g.branch],
					['HEAD', g.head ? g.head.slice(0, 12) : null, true],
					[
						'vs ' + (g.anchorRef || 'anchor'),
						g.aheadOfAnchor != null ? `${g.aheadOfAnchor} ahead, ${g.behindAnchor} behind` : null,
					],
					['error', g.error],
				],
			}),
		);
		for (const file of diverging) {
			body.append(
				renderRow({
					title: file,
					path: `${g.root}/${file}`,
					line: 1,
					link: `vscode://file${g.root}/${file}:1`,
					badges: [{ text: `differs from ${g.anchorRef}`, kind: 'warn' }],
					fields: [
						[
							'note',
							'Tracked config that this branch changed. Your session follows THIS file, not the anchor version.',
						],
					],
				}),
			);
		}
		body.append(el('div', { className: 'note', textContent: g.machineScopeNote || '' }));
		card.append(body);
		main.append(card);
	}

	// Headline cost, shown before any section. `discovered` vs `effective` is the
	// whole point: the plugin cache keeps stale versions and disabled plugins on
	// disk, so the naive sum roughly doubles the real number.
	const d = state.derived;
	if (d?.totalEstimatedTokens != null) {
		const summary = el('section', { className: 'card', id: 'section-summary' });
		summary.append(
			el('h2', {}, ['Always-resident context', badge(`~${d.totalEstimatedTokens.toLocaleString()} est. tokens`, 'ok')]),
		);
		const body = el('div', { className: 'section-body' });
		body.append(
			renderRow({
				title: 'Memory chain',
				badges: [{ text: `${d.memory.alwaysInjectedFiles} files always injected`, kind: 'ok' }],
				fields: [
					['est. tokens', d.memory.estimatedTokens],
					['bytes', d.memory.alwaysInjectedBytes],
					['loaded on demand', `${d.memory.onDemandFiles} more files`],
					// One field per resident file, labelled by the scope it comes from.
					// The badge counts them; without the paths the reader still has to
					// go looking for which two files the number means.
					...(d.memory.alwaysInjectedPaths ?? []).map((file) => [
						file.layer || 'file',
						`${displayPath(file.path, ctx)} — ${file.bytes} bytes`,
						true,
					]),
				],
			}),
			d.hooks
				? renderRow({
						title: 'Hook output',
						badges: [
							{ text: `${d.hooks.startEstimatedTokens} tokens at session start`, kind: 'ok' },
							{ text: `+${d.hooks.perTurnBytes} bytes per turn`, kind: 'warn' },
						],
						fields: [
							['at session start', `${d.hooks.startBytes} bytes ≈ ${d.hooks.startEstimatedTokens} tokens`],
							['per turn', `${d.hooks.perTurnBytes} bytes ≈ ${d.hooks.perTurnEstimatedTokens} tokens — not in the total`],
							['measured on', d.hooks.transcriptPath ? d.hooks.transcriptPath.split('/').pop() : null, true],
							// One field per hook, largest first: the total is checkable
							// against its parts, and the parts name what to trim.
							...d.hooks.hooks.map((hook) => [
								`${hook.phase === 'start' ? 'start' : 'turn'} · ${hook.hookName} · ${hook.label}`,
								`${hook.bytes} bytes${hook.runs > 1 ? ` in ${hook.runs} runs` : ''}`,
								true,
							]),
						],
					})
				: null,
			renderRow({
				title: 'Skill listing',
				badges: [{ text: `${d.skills.effective.count} of ${d.skills.discovered.count} actually load`, kind: 'warn' }],
				fields: [
					[
						'est. tokens',
						`${d.skills.effective.estimatedTokens} (naive sum would be ${d.skills.discovered.estimatedTokens})`,
					],
					['my own', d.skills.effective.mine],
					['from plugins', d.skills.effective.fromPlugin],
					['hidden by skillOverrides', d.skills.excluded.hiddenByOverride],
					['shadowed by a higher scope', d.skills.excluded.shadowed],
					['in a stale cached plugin version', d.skills.excluded.staleCachedVersion],
					['in a disabled plugin', d.skills.excluded.disabledPlugin],
				],
			}),
		);
		body.append(el('div', { className: 'note', textContent: d.note }));
		summary.append(body);
		main.append(summary);
	}

	activeBypasses = compileBypasses(state.curation);
	const guardrails = renderGuardrailsCard(state, ctx);
	main.append(guardrails.card);

	const order = state.meta?.sectionOrder || [];
	const built = [{ id: 'guardrails', label: 'Guardrails', count: guardrails.count }];
	for (const { id, label } of order) {
		const { card, count } = renderSection(id, label, state.sections?.[id], ctx);
		main.append(card);
		built.push({ id, label, count, errored: state.sections?.[id]?.ok === false });
	}
	const conflicts = renderConflicts(state);
	main.append(conflicts.card);
	built.push({ id: 'conflicts', label: 'Conflicts', count: conflicts.count });

	for (const item of built) {
		const button = el('button', { type: 'button' }, [
			item.label,
			// A dashboard entry (Guardrails) carries no row count: the number was
			// noise, and the filter arithmetic has nothing meaningful to update.
			item.count == null ? null : el('span', { className: 'count', textContent: item.errored ? '!' : String(item.count) }),
		]);
		button.dataset.id = item.id;
		button.addEventListener('click', () => selectSection(item.id));
		nav.append(button);
	}
	// WHOSE counts these are. The two harnesses have different servers, skills and
	// hooks, so the same nav row legitimately reads 5 for one and 11 for the
	// other. Reading a number here without knowing the harness is how the panel
	// looked unstable when it was only ever answering a different question — and
	// the choice is remembered across tabs, so it can differ from the tab you
	// opened last without you having touched anything.
	nav.prepend(
		el(
			'div',
			{
				className: 'nav-harness',
				title: 'Every count below belongs to this harness. Change it with the selector in the header.',
			},
			[
				el('span', { className: 'nav-harness-label', textContent: 'Inventorying' }),
				el('strong', { textContent: harnessLabel(activeHarness) }),
			],
		),
	);

	await populateRoots(state);
	if (state.rootRejected) {
		main.prepend(
			el('div', {
				className: 'error-box',
				textContent: `Requested working tree is not a git worktree of this repo — showing ${state.projectRoot} instead.`,
			}),
		);
	}
	selectSection(active);
	const errors = built.filter((b) => b.errored).length;
	if (staleCode) {
		main.prepend(
			el('div', { className: 'error-box' }, [
				el('div', {
					textContent: `This page is running the panel code from build ${loadedBuild}, but the server is now on ${state.build}. Refresh re-reads your config, not this page — reload the tab (Cmd+Shift+R) to pick up the newer panel.`,
				}),
			]),
		);
	}
	const started = state.serverStartedAt ? new Date(state.serverStartedAt).toLocaleTimeString() : '?';
	status.textContent = `:${state.port ?? location.port} · booted ${started} · ${new Date(state.generatedAt).toLocaleTimeString()}${errors ? ` · ${errors} section(s) failed` : ''}${staleCode ? ' · page code is stale — reload' : ''}`;
	status.title = `Panel instance on port ${state.port ?? location.port}, started ${state.serverStartedAt || 'unknown'}. If another tab shows a different port, one of them is an older build.`;
}

search.addEventListener('input', applyFilter);

const scopeSelect = document.getElementById('scope');
scopeSelect.addEventListener('change', () => {
	activeScope = scopeSelect.value;
	applyFilter();
});

/**
 * The harness selector. Changing it changes the SUBJECT of the whole panel, not
 * a filter over it, so everything is refetched and the section selection is
 * dropped: the two registries do not have the same sections (`execpolicy` is
 * Codex-only), and keeping a nav item selected that the next harness does not
 * have would show an empty panel with no explanation.
 */
const harnessSelect = document.getElementById('harness');
harnessSelect.value = activeHarness;
applyHarnessChrome();
rememberHarness();
harnessSelect.addEventListener('change', () => {
	activeHarness = harnessSelect.value;
	rememberHarness();
	applyHarnessChrome();
	active = 'guardrails';
	render({ force: true });
});

const rootSelect = document.getElementById('root');
rootSelect.addEventListener('change', () => {
	activeRoot = rootSelect.value || null;
	render({ force: true });
});

/**
 * Fills the working-tree selector from the server's allowlist. Every option is
 * a real worktree on disk, read exactly as it is — this is a change of subject,
 * not a simulation of one branch's files inside another tree.
 */
async function populateRoots(state) {
	if (rootSelect.options.length > 0) {
		rootSelect.value = state.projectRoot;
		return;
	}
	let roots = [state.projectRoot];
	try {
		const response = await fetch('/api/roots');
		const payload = await response.json();
		if (Array.isArray(payload.roots) && payload.roots.length) roots = payload.roots;
	} catch {
		// selector degrades to the launch root; the panel still works
	}
	for (const entry of roots) {
		const root = typeof entry === 'string' ? entry : entry.path;
		const branch = typeof entry === 'string' ? null : entry.branch;
		const dir = root.split('/').pop() || root;
		// Branch first: that is the identity the reader is choosing between. The
		// directory follows, because two worktrees can never share a branch but
		// the directory is what you cd into.
		let label = branch ? `${branch}  ·  ${dir}` : dir;
		if (typeof entry !== 'string' && entry.isMain) label += '  [main checkout]';
		if (root === state.launchRoot) label += '  (launched here)';
		rootSelect.append(el('option', { value: root, textContent: label }));
	}
	rootSelect.value = state.projectRoot;
}

/**
 * Snapshots, entirely in the browser.
 *
 * Persisting them server-side would need a POST route and a write path, which
 * would cost the panel its two load-bearing guarantees: every non-GET verb
 * answers 405, and no code path writes anything. So the browser downloads the
 * JSON the panel already serves, and later reads one back through a file
 * picker. The server never learns a snapshot exists.
 *
 * The diff itself is lib/snapshot-diff.mjs — a pure module with no imports,
 * served to the page so the browser runs exactly the code the tests cover
 * rather than a second implementation that could drift from it.
 */
let lastState = null;
/** The server build this page's JS was loaded against; see render(). */
let loadedBuild = null;

/** Which harness a snapshot describes. Snapshots taken before the selector existed have none. */
function snapshotHarness(snapshot) {
	const harness = snapshot?.meta?.harness;
	if (typeof harness === 'string') return harness;
	return typeof harness?.id === 'string' ? harness.id : null;
}

function saveSnapshot() {
	if (!lastState) return;
	const stamp = (lastState.generatedAt || '').replace(/[:.]/g, '-').slice(0, 19) || 'snapshot';
	const dir = (lastState.projectRoot || '').split('/').pop() || 'workspace';
	// The harness is in the filename as well as the payload: two snapshots of the
	// same repo taken minutes apart can describe different harnesses, and picking
	// the wrong file is a mistake the panel should not let you make blind.
	const name = `harness-${activeHarness}-${dir}-${stamp}.json`;
	const snapshot = {
		...lastState,
		meta: {
			...(lastState.meta || {}),
			harness: lastState.meta?.harness ?? { id: activeHarness, label: harnessLabel(activeHarness) },
		},
	};
	const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = el('a', { href: url, download: name });
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
	status.textContent = `snapshot saved as ${name}`;
}

async function compareSnapshot(file) {
	if (!file || !lastState) return;
	status.textContent = 'comparing…';
	let before;
	try {
		before = JSON.parse(await file.text());
	} catch (error) {
		status.textContent = `not a snapshot: ${error?.message || error}`;
		return;
	}
	// Two harnesses share section ids but not their meaning: Codex's `commands`
	// are custom prompts, its `worktrees` are trust levels. Diffing across them
	// would report every row as added and removed — a wall of false change. A
	// snapshot older than the selector has no harness recorded, and an absent
	// fact is not a mismatch, so those still compare.
	const beforeHarness = snapshotHarness(before);
	const afterHarness = snapshotHarness(lastState) || activeHarness;
	if (beforeHarness && afterHarness && beforeHarness !== afterHarness) {
		status.textContent = `that snapshot is from ${harnessLabel(beforeHarness)}; this view is ${harnessLabel(afterHarness)} — switch the harness selector to compare it`;
		return;
	}
	let diff;
	try {
		const mod = await import('/lib/snapshot-diff.mjs');
		diff = mod.diffSnapshots(before, lastState);
	} catch (error) {
		status.textContent = `diff unavailable: ${error?.message || error}`;
		return;
	}
	renderDiff(diff, file.name);
}

function renderDiff(diff, fileName) {
	const card = el('section', { className: 'card', id: 'section-diff' });
	const comparable = diff?.meta?.comparable !== false;
	card.append(
		el(
			'h2',
			{},
			[
				'Changes since snapshot',
				badge(
					comparable
						? `${diff.summary.changed} changed · ${diff.summary.added} added · ${diff.summary.removed} removed`
						: 'not comparable',
					comparable ? 'warn' : 'bad',
				),
				diff?.meta?.sameRoot === false ? badge('different project', 'bad') : null,
			].filter(Boolean),
		),
	);
	const body = el('div', { className: 'section-body' });
	if (!comparable) {
		body.append(
			el('div', { className: 'error-box', textContent: diff?.meta?.reason || 'the file is not a panel snapshot' }),
		);
	} else {
		body.append(
			el('div', {
				className: 'note',
				textContent: `${fileName} · taken ${diff.meta.beforeAt || 'unknown'} · compared against ${diff.meta.afterAt || 'now'}`,
			}),
		);
		for (const line of diff.headline || [])
			body.append(renderRow({ title: line, badges: [{ text: 'change', kind: 'warn' }], fields: [] }));
		if (!(diff.headline || []).length)
			body.append(el('div', { className: 'note', textContent: 'nothing changed between the two states' }));
		for (const section of diff.sections || []) {
			if (!section.counts || section.counts.added + section.counts.removed + section.counts.changed === 0) continue;
			body.append(
				el('div', { className: 'note' }, [
					el('b', { textContent: section.label || section.id }),
					` — +${section.counts.added} / -${section.counts.removed} / ~${section.counts.changed}`,
				]),
			);
			for (const item of section.changed || []) {
				body.append(
					renderRow({
						title: item.key,
						badges: [{ text: 'changed', kind: 'warn' }],
						fields: [
							['before', short(item.before, 90), true],
							['after', short(item.after, 90), true],
						],
					}),
				);
			}
			for (const item of section.added || [])
				body.append(renderRow({ title: item.key, badges: [{ text: 'added', kind: 'ok' }], fields: [] }));
			for (const item of section.removed || [])
				body.append(renderRow({ title: item.key, badges: [{ text: 'removed', kind: 'off' }], fields: [] }));
		}
	}
	card.append(body);
	const existing = document.getElementById('section-diff');
	if (existing) existing.replaceWith(card);
	else main.prepend(card);
	card.dataset.total = String(card.querySelectorAll('.row:not(.finding)').length);
	status.textContent = comparable ? `compared against ${fileName}` : 'snapshot not comparable';
}

const refreshButton = document.getElementById('refresh');
document.getElementById('snap-save').addEventListener('click', saveSnapshot);
const snapFile = document.getElementById('snap-file');
document.getElementById('snap-load').addEventListener('click', () => snapFile.click());
snapFile.addEventListener('change', () => {
	const file = snapFile.files?.[0];
	snapFile.value = '';
	compareSnapshot(file);
});

refreshButton.addEventListener('click', async () => {
	refreshButton.disabled = true;
	refreshButton.textContent = 'Reading…';
	try {
		await render({ force: true });
	} finally {
		refreshButton.disabled = false;
		refreshButton.textContent = 'Refresh';
	}
});

const events = new EventSource('/api/events');
events.addEventListener('update', (event) => {
	let changed = '';
	let harness = null;
	try {
		const payload = JSON.parse(event.data);
		changed = payload?.changed || '';
		harness = payload?.harness ?? null;
	} catch {
		/* the banner is cosmetic; a malformed frame must not stop the refresh */
	}
	// The server names the harness a changed file belongs to. `null` means it
	// could not attribute the change to one — a shared path, or several files
	// moving at once — and those always refresh, because showing a stale panel is
	// worse than one unnecessary re-read.
	if (harness && harness !== activeHarness) return;
	status.textContent = `change detected${changed ? ` in ${changed.split('/').pop()}` : ''} — refreshing…`;
	render();
});

render();
