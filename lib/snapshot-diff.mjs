/**
 * Snapshot comparison: "what changed in my harness since yesterday".
 *
 * Snapshots are downloaded and re-loaded entirely in the BROWSER — the server
 * never writes anything, so this module never touches a filesystem. It takes
 * two already-fetched `/api/state` objects and returns their differences.
 *
 * PURE. No fs, no child_process, no network, no Date.now(), no Math.random().
 * Same two inputs always produce the same (deepEqual) output, and neither
 * input is ever mutated.
 *
 * NEVER THROWS. A missing, non-object, or structurally broken snapshot on
 * either side yields `meta.comparable: false` with a human `reason` instead
 * of an exception. A single section whose payload shape this module does not
 * recognise (a scanner error, a future schema change) is reported as
 * "could not be compared" rather than silently dropped or crashing the rest
 * of the diff.
 *
 * IDENTITY, NOT RAW OBJECT COMPARE. Each section defines a stable identity
 * key (see SECTION_DEFS below) and compares only the handful of fields that
 * actually describe a meaningful change for that kind of item — a raw
 * deep-equal of scanner output would flag noise (line numbers, deep links)
 * as churn and bury the real signal.
 *
 * HEADLINE IS RANKED, NOT CHRONOLOGICAL. `headline` is sorted by consequence:
 * a setting's winning layer silently changing ranks above its value changing,
 * which ranks above raw added/removed counts. See TIER_* below.
 */

// --- generic helpers -------------------------------------------------------

/** True for a plain object (not null, not an array). */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A structurally valid /api/state snapshot: an object with a `.sections` object. */
function isStateObject(value) {
	return isPlainObject(value) && isPlainObject(value.sections);
}

function describeInvalid(label, value) {
	if (value === null || value === undefined) return `${label} snapshot is missing`;
	if (!isPlainObject(value)) return `${label} snapshot is not a state object`;
	if (!isPlainObject(value.sections)) return `${label} snapshot has no sections`;
	return `${label} snapshot is invalid`;
}

/** JSON-safe deep equality: objects, arrays, and primitives only. */
function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null || typeof a !== 'object') return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(b, key)) return false;
		if (!deepEqual(a[key], b[key])) return false;
	}
	return true;
}

function truncate(text, max) {
	if (typeof text !== 'string') return text;
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Human display for a settings leaf value, which may be a scalar, array, or object. */
function fmtVal(value) {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'string') return truncate(value, 60);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return truncate(JSON.stringify(value), 60);
	} catch {
		return '(unrepresentable value)';
	}
}

function fmtLayer(layerId) {
	return layerId == null ? '(none)' : layerId;
}

function formatThousands(n) {
	const truncated = Math.trunc(n);
	const negative = truncated < 0;
	const digits = Math.abs(truncated).toString();
	const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return negative ? `-${grouped}` : grouped;
}

function formatSignedDelta(delta) {
	return delta > 0 ? `+${formatThousands(delta)}` : formatThousands(delta);
}

/**
 * Pulls the first array out of `data` found among `candidates`, where the
 * empty string means "data itself is the array". Returns null when nothing
 * matches — the caller treats that as an unrecognised payload shape.
 */
function extractArray(data, candidates) {
	if (data === null || data === undefined) return null;
	for (const prop of candidates) {
		const value = prop === '' ? data : isPlainObject(data) ? data[prop] : undefined;
		if (Array.isArray(value)) return value;
	}
	return null;
}

/** Builds key -> item from a list, skipping unkeyable garbage entries. Later duplicates win. */
function toItemMap(list, keyOf) {
	const map = new Map();
	for (const item of list) {
		if (item === null || typeof item !== 'object') continue;
		const key = keyOf(item);
		if (typeof key !== 'string' || key.length === 0) continue;
		map.set(key, item);
	}
	return map;
}

// --- headline tiers (lower sorts first = more consequential) ---------------

const TIER_LAYER_DRIFT = 0; // a setting's winning layer changed
const TIER_HIGH_IMPACT = 1; // skill/plugin/mcp toggled, hook script vanished
const TIER_VALUE_CHANGE = 2; // a value-level change with no drift/toggle story
const TIER_TOKEN_MOVEMENT = 3; // derived always-resident token cost
const TIER_UNRECOGNISED = 4; // a section payload this module could not read
const TIER_CHURN = 5; // pure added/removed counts

// --- per-section definitions -------------------------------------------------

const SECTION_DEFS = [
	{
		id: 'settings',
		label: 'Settings',
		noun: 'setting keys',
		extract: (data) => extractArray(data, ['keys']),
		keyOf: (item) => (typeof item.key === 'string' && item.key.length > 0 ? item.key : null),
		summarize: (item) => ({
			effectiveValue: item.effectiveValue ?? null,
			winningLayer: item.winningLayer ?? null,
			known: item.known ?? null,
			ownerOnly: item.ownerOnly ?? null,
			secret: item.secret ?? null,
		}),
		fieldsEqual: (b, a) =>
			deepEqual(b.effectiveValue ?? null, a.effectiveValue ?? null) && b.winningLayer === a.winningLayer,
		narrativeForChange: (key, b, a) => {
			const layerChanged = b.winningLayer !== a.winningLayer;
			const valueChanged = !deepEqual(b.effectiveValue ?? null, a.effectiveValue ?? null);
			if (layerChanged) {
				const valuePart = valueChanged
					? `, value also changed: ${fmtVal(b.effectiveValue)} -> ${fmtVal(a.effectiveValue)}`
					: ' (value unchanged)';
				return {
					tier: TIER_LAYER_DRIFT,
					text: `Setting "${key}": winning layer changed ${fmtLayer(b.winningLayer)} -> ${fmtLayer(a.winningLayer)}${valuePart}.`,
				};
			}
			if (valueChanged) {
				return {
					tier: TIER_VALUE_CHANGE,
					text: `Setting "${key}" changed: ${fmtVal(b.effectiveValue)} -> ${fmtVal(a.effectiveValue)}.`,
				};
			}
			return null;
		},
	},
	{
		id: 'skills',
		label: 'Skills',
		noun: 'skills',
		extract: (data) => extractArray(data, ['skills']),
		keyOf: (item) => item.qualifiedName || item.name || null,
		summarize: (item) => ({
			name: item.name ?? null,
			qualifiedName: item.qualifiedName ?? null,
			layer: item.layer ?? null,
			plugin: item.plugin ?? null,
			state: item.state ?? null,
			shadowedBy: item.shadowedBy ?? null,
		}),
		fieldsEqual: (b, a) => b.state === a.state && b.shadowedBy === a.shadowedBy,
		narrativeForChange: (key, b, a) => {
			if (b.state !== a.state) {
				if (a.state === 'off' && b.state !== 'off') {
					return { tier: TIER_HIGH_IMPACT, text: `Skill "${key}" turned off (was ${b.state}).` };
				}
				if (b.state === 'off' && a.state !== 'off') {
					return { tier: TIER_HIGH_IMPACT, text: `Skill "${key}" turned on (was off, now ${a.state}).` };
				}
				return { tier: TIER_VALUE_CHANGE, text: `Skill "${key}" state changed: ${b.state} -> ${a.state}.` };
			}
			if (b.shadowedBy !== a.shadowedBy) {
				if (a.shadowedBy && !b.shadowedBy) {
					return {
						tier: TIER_HIGH_IMPACT,
						text: `Skill "${key}" is now shadowed by ${a.shadowedBy} (effectively hidden from the model).`,
					};
				}
				if (b.shadowedBy && !a.shadowedBy) {
					return { tier: TIER_VALUE_CHANGE, text: `Skill "${key}" is no longer shadowed (visible again).` };
				}
				return {
					tier: TIER_VALUE_CHANGE,
					text: `Skill "${key}" shadowing layer changed: ${b.shadowedBy} -> ${a.shadowedBy}.`,
				};
			}
			return null;
		},
	},
	{
		id: 'hooks',
		label: 'Hooks',
		noun: 'hooks',
		extract: (data) => extractArray(data, ['', 'hooks']),
		keyOf: (item) => `${item.layer ?? ''}:${item.event ?? ''}:${item.matcher ?? ''}:${item.command ?? ''}`,
		summarize: (item) => ({
			layer: item.layer ?? null,
			event: item.event ?? null,
			matcher: item.matcher ?? null,
			command: item.command ?? null,
			scriptPath: item.scriptPath ?? null,
			scriptExists: item.scriptExists ?? null,
			type: item.type ?? null,
			timeout: item.timeout ?? null,
		}),
		fieldsEqual: (b, a) => b.scriptExists === a.scriptExists,
		narrativeForChange: (key, b, a) => {
			const where = `${a.layer ?? b.layer}:${a.event ?? b.event}`;
			const target = a.scriptPath ?? a.command ?? b.scriptPath ?? b.command ?? key;
			if (b.scriptExists && !a.scriptExists) {
				return {
					tier: TIER_HIGH_IMPACT,
					text: `Hook script vanished for ${where}: ${target} (still configured, now a silent no-op).`,
				};
			}
			if (!b.scriptExists && a.scriptExists) {
				return { tier: TIER_VALUE_CHANGE, text: `Hook script restored for ${where}: ${target}.` };
			}
			return null;
		},
	},
	{
		id: 'mcp',
		label: 'MCP servers',
		noun: 'MCP servers',
		extract: (data) => extractArray(data, ['servers']),
		keyOf: (item) => `${item.scope ?? ''}:${item.name ?? ''}`,
		summarize: (item) => ({
			name: item.name ?? null,
			scope: item.scope ?? null,
			transport: item.transport ?? null,
			disabled: item.disabled ?? null,
			command: item.command ?? null,
			url: item.url ?? null,
		}),
		fieldsEqual: (b, a) => b.disabled === a.disabled && b.transport === a.transport,
		narrativeForChange: (key, b, a) => {
			if (b.disabled !== a.disabled) {
				return a.disabled
					? { tier: TIER_HIGH_IMPACT, text: `MCP server "${key}" disabled (was enabled).` }
					: { tier: TIER_HIGH_IMPACT, text: `MCP server "${key}" enabled (was disabled).` };
			}
			if (b.transport !== a.transport) {
				return {
					tier: TIER_VALUE_CHANGE,
					text: `MCP server "${key}" transport changed: ${b.transport} -> ${a.transport}.`,
				};
			}
			return null;
		},
	},
	{
		id: 'plugins',
		label: 'Plugins',
		noun: 'plugins',
		extract: (data) => extractArray(data, ['plugins', '']),
		keyOf: (item) => (typeof item.key === 'string' && item.key.length > 0 ? item.key : null),
		summarize: (item) => ({
			name: item.name ?? null,
			marketplace: item.marketplace ?? null,
			version: item.version ?? null,
			enabled: item.enabled ?? null,
		}),
		fieldsEqual: (b, a) => b.enabled === a.enabled && b.version === a.version,
		narrativeForChange: (key, b, a) => {
			if (b.enabled !== a.enabled) {
				return a.enabled
					? { tier: TIER_HIGH_IMPACT, text: `Plugin "${key}" enabled (was disabled).` }
					: { tier: TIER_HIGH_IMPACT, text: `Plugin "${key}" disabled (was enabled).` };
			}
			if (b.version !== a.version) {
				return { tier: TIER_VALUE_CHANGE, text: `Plugin "${key}" version changed: ${b.version} -> ${a.version}.` };
			}
			return null;
		},
	},
	{
		id: 'commands',
		label: 'Slash commands',
		noun: 'commands',
		extract: (data) => extractArray(data, ['commands']),
		keyOf: (item) => (typeof item.name === 'string' && item.name.length > 0 ? item.name : null),
		summarize: (item) => ({
			name: item.name ?? null,
			layer: item.layer ?? null,
			disableModelInvocation: item.disableModelInvocation ?? null,
		}),
		fieldsEqual: (b, a) => b.disableModelInvocation === a.disableModelInvocation,
		narrativeForChange: (key, b, a) => ({
			tier: TIER_VALUE_CHANGE,
			text: `Command "/${key}" model-invocation ${a.disableModelInvocation ? 'disabled' : 'enabled'} (was ${
				b.disableModelInvocation ? 'disabled' : 'enabled'
			}).`,
		}),
	},
	{
		id: 'agents',
		label: 'Subagents',
		noun: 'agents',
		extract: (data) => extractArray(data, ['', 'agents']),
		keyOf: (item) =>
			item.name || (typeof item.path === 'string' && item.path.length > 0 ? `__unnamed__:${item.path}` : null),
		summarize: (item) => ({
			name: item.name ?? null,
			layer: item.layer ?? null,
			plugin: item.plugin ?? null,
			model: item.model ?? null,
			valid: item.valid ?? null,
		}),
		fieldsEqual: (b, a) => b.model === a.model,
		narrativeForChange: (key, b, a) => ({
			tier: TIER_VALUE_CHANGE,
			text: `Agent "${key}" model changed: ${b.model ?? '(default)'} -> ${a.model ?? '(default)'}.`,
		}),
	},
	{
		id: 'memory',
		label: 'Memory / instructions',
		noun: 'memory files',
		extract: (data) => extractArray(data, ['', 'entries']),
		keyOf: (item) => (typeof item.path === 'string' && item.path.length > 0 ? item.path : null),
		summarize: (item) => ({
			path: item.path ?? null,
			layer: item.layer ?? null,
			bytes: item.bytes ?? null,
			estimatedTokens: item.estimatedTokens ?? null,
			alwaysInjected: item.alwaysInjected ?? null,
			exists: item.exists ?? null,
		}),
		fieldsEqual: (b, a) => b.bytes === a.bytes,
		narrativeForChange: (key, b, a) => ({
			tier: TIER_TOKEN_MOVEMENT,
			text: `Memory file ${key} size changed: ${b.bytes ?? 0} -> ${a.bytes ?? 0} bytes.`,
		}),
	},
	{
		id: 'rules',
		label: 'Rules',
		noun: 'rules',
		extract: (data) => extractArray(data, ['rules']),
		keyOf: (item) => (typeof item.name === 'string' && item.name.length > 0 ? item.name : null),
		summarize: (item) => ({
			name: item.name ?? null,
			bytes: item.bytes ?? null,
			estimatedTokens: item.estimatedTokens ?? null,
			title: item.title ?? null,
			mandatory: item.mandatory ?? null,
		}),
		fieldsEqual: (b, a) => b.bytes === a.bytes,
		narrativeForChange: (key, b, a) => ({
			tier: TIER_TOKEN_MOVEMENT,
			text: `Rule "${key}" size changed: ${b.bytes ?? 0} -> ${a.bytes ?? 0} bytes.`,
		}),
	},
	{
		id: 'worktrees',
		label: 'Worktree drift',
		noun: 'worktrees',
		extract: (data) => extractArray(data, ['worktrees']),
		keyOf: (item) => (typeof item.path === 'string' && item.path.length > 0 ? item.path : null),
		summarize: (item) => ({
			path: item.path ?? null,
			branch: item.branch ?? null,
			driftKind: item.driftKind ?? null,
			isMain: item.isMain ?? null,
			exists: item.exists ?? null,
		}),
		fieldsEqual: (b, a) => b.driftKind === a.driftKind,
		narrativeForChange: (key, b, a) => ({
			tier: TIER_VALUE_CHANGE,
			text: `Worktree ${key} drift changed: ${b.driftKind} -> ${a.driftKind}.`,
		}),
	},
];

// --- derived (cross-section token cost) headline ----------------------------

/**
 * Token-cost movement, always-resident context first. Reads only
 * `derived.totalEstimatedTokens` (already built from memory + EFFECTIVE
 * skill numbers upstream, never discovered) with a narrower fallback to
 * `derived.skills.effective.estimatedTokens` alone when the total is absent.
 */
function derivedHeadlineNote(before, after) {
	const db = isPlainObject(before?.derived) ? before.derived : null;
	const da = isPlainObject(after?.derived) ? after.derived : null;
	if (!db || !da) return null;

	const totalB = typeof db.totalEstimatedTokens === 'number' ? db.totalEstimatedTokens : null;
	const totalA = typeof da.totalEstimatedTokens === 'number' ? da.totalEstimatedTokens : null;
	if (totalB !== null && totalA !== null && totalB !== totalA) {
		const delta = totalA - totalB;
		return {
			tier: TIER_TOKEN_MOVEMENT,
			sortKey: 'derived:total',
			text: `Always-resident context: ${formatThousands(totalB)} -> ${formatThousands(totalA)} est. tokens (${formatSignedDelta(delta)}).`,
		};
	}

	const effB = db.skills?.effective?.estimatedTokens;
	const effA = da.skills?.effective?.estimatedTokens;
	if (typeof effB === 'number' && typeof effA === 'number' && effB !== effA) {
		const delta = effA - effB;
		return {
			tier: TIER_TOKEN_MOVEMENT,
			sortKey: 'derived:skills-effective',
			text: `Effective skill listing: ${formatThousands(effB)} -> ${formatThousands(effA)} est. tokens (${formatSignedDelta(delta)}).`,
		};
	}

	return null;
}

// --- meta --------------------------------------------------------------------

function buildMeta(before, after) {
	const beforeAt = typeof before?.generatedAt === 'string' ? before.generatedAt : null;
	const afterAt = typeof after?.generatedAt === 'string' ? after.generatedAt : null;
	const beforeRoot = typeof before?.projectRoot === 'string' ? before.projectRoot : null;
	const afterRoot = typeof after?.projectRoot === 'string' ? after.projectRoot : null;
	const sameRoot = beforeRoot !== null && afterRoot !== null && beforeRoot === afterRoot;

	const beforeValid = isStateObject(before);
	const afterValid = isStateObject(after);
	if (!beforeValid || !afterValid) {
		const reasons = [];
		if (!beforeValid) reasons.push(describeInvalid('before', before));
		if (!afterValid) reasons.push(describeInvalid('after', after));
		return { beforeAt, afterAt, beforeRoot, afterRoot, sameRoot, comparable: false, reason: reasons.join('; ') };
	}

	return { beforeAt, afterAt, beforeRoot, afterRoot, sameRoot, comparable: true, reason: null };
}

// --- one section's diff -------------------------------------------------------

function diffOneSection(def, before, after) {
	const wrapperBefore = isPlainObject(before.sections) ? before.sections[def.id] : undefined;
	const wrapperAfter = isPlainObject(after.sections) ? after.sections[def.id] : undefined;
	const presentBefore = isPlainObject(wrapperBefore);
	const presentAfter = isPlainObject(wrapperAfter);

	if (!presentBefore && !presentAfter) return { section: null, notes: [] };

	const arrBefore = presentBefore ? def.extract(wrapperBefore.data) : null;
	const arrAfter = presentAfter ? def.extract(wrapperAfter.data) : null;
	const badBefore = presentBefore && arrBefore === null;
	const badAfter = presentAfter && arrAfter === null;

	const emptySection = () => ({
		id: def.id,
		label: def.label,
		added: [],
		removed: [],
		changed: [],
		counts: { added: 0, removed: 0, changed: 0 },
	});

	if (badBefore || badAfter) {
		const reasonParts = [];
		if (badBefore) {
			reasonParts.push(
				wrapperBefore.ok === false
					? `before: scanner failed (${wrapperBefore.error ?? 'unknown error'})`
					: 'before: unrecognised data shape',
			);
		}
		if (badAfter) {
			reasonParts.push(
				wrapperAfter.ok === false
					? `after: scanner failed (${wrapperAfter.error ?? 'unknown error'})`
					: 'after: unrecognised data shape',
			);
		}
		return {
			section: emptySection(),
			notes: [
				{
					tier: TIER_UNRECOGNISED,
					sortKey: `${def.id}:~unrecognised`,
					text: `${def.label} could not be compared (${reasonParts.join('; ')}).`,
				},
			],
		};
	}

	const listBefore = arrBefore ?? [];
	const listAfter = arrAfter ?? [];
	const mapBefore = toItemMap(listBefore, def.keyOf);
	const mapAfter = toItemMap(listAfter, def.keyOf);

	const added = [];
	const removed = [];
	const changed = [];
	const notes = [];
	let unchangedCount = 0;

	for (const [key, itemBefore] of mapBefore) {
		const itemAfter = mapAfter.get(key);
		if (itemAfter === undefined) {
			removed.push({ key, value: def.summarize(itemBefore) });
			continue;
		}
		if (def.fieldsEqual(itemBefore, itemAfter)) {
			unchangedCount += 1;
			continue;
		}
		changed.push({ key, before: def.summarize(itemBefore), after: def.summarize(itemAfter) });
		const note = def.narrativeForChange(key, itemBefore, itemAfter);
		if (note) notes.push({ ...note, sortKey: `${def.id}:${key}` });
	}
	for (const [key, itemAfter] of mapAfter) {
		if (!mapBefore.has(key)) added.push({ key, value: def.summarize(itemAfter) });
	}

	added.sort((x, y) => x.key.localeCompare(y.key));
	removed.sort((x, y) => x.key.localeCompare(y.key));
	changed.sort((x, y) => x.key.localeCompare(y.key));

	if (added.length > 0 || removed.length > 0) {
		const parts = [];
		if (added.length > 0) parts.push(`${added.length} ${def.noun} added`);
		if (removed.length > 0) parts.push(`${removed.length} ${def.noun} removed`);
		notes.push({ tier: TIER_CHURN, sortKey: `${def.id}:~churn`, text: `${parts.join(', ')}.` });
	}

	return {
		section: {
			id: def.id,
			label: def.label,
			added,
			removed,
			changed,
			counts: { added: added.length, removed: removed.length, changed: changed.length },
		},
		notes,
		unchangedCount,
	};
}

// --- entry point ---------------------------------------------------------------

/**
 * Compares two `/api/state` snapshots. Pure, read-only, never throws.
 *
 * @param {unknown} before
 * @param {unknown} after
 * @returns {object} see module doc for the returned shape
 */
export function diffSnapshots(before, after) {
	try {
		const meta = buildMeta(before, after);

		if (!meta.comparable) {
			return {
				meta,
				summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
				sections: [],
				headline: [`Cannot compare: ${meta.reason}`],
			};
		}

		const totals = { added: 0, removed: 0, changed: 0, unchanged: 0 };
		const sections = [];
		const notes = [];

		for (const def of SECTION_DEFS) {
			const result = diffOneSection(def, before, after);
			if (result.section) {
				sections.push(result.section);
				totals.added += result.section.counts.added;
				totals.removed += result.section.counts.removed;
				totals.changed += result.section.counts.changed;
				totals.unchanged += result.unchangedCount ?? 0;
			}
			notes.push(...result.notes);
		}

		const derivedNote = derivedHeadlineNote(before, after);
		if (derivedNote) notes.push(derivedNote);

		notes.sort((x, y) => x.tier - y.tier || x.sortKey.localeCompare(y.sortKey));

		return {
			meta,
			summary: totals,
			sections,
			headline: notes.map((note) => note.text),
		};
	} catch (error) {
		return {
			meta: {
				beforeAt: null,
				afterAt: null,
				beforeRoot: null,
				afterRoot: null,
				sameRoot: false,
				comparable: false,
				reason: `internal diff error: ${String(error?.message || error)}`,
			},
			summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
			sections: [],
			headline: [`Cannot compare: internal diff error: ${String(error?.message || error)}`],
		};
	}
}
