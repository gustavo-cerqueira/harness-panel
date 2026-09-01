/**
 * The settings cascade merge — which value is actually LIVE.
 *
 * Everything else in the panel describes files. This module answers the only
 * question that changes what Claude Code does, so it is the one place where a
 * subtle mistake makes the whole panel confidently misleading.
 *
 * Four decisions carry the module:
 *
 * 1. PRECEDENCE IS AUTHORITY, NOT READING ORDER. The cascade is
 *    user < project < local, with enterprise managed policy over all three.
 *    That ordering lives in `lib/layers.mjs` as a numeric `authority` and is
 *    resolved here through `winningLayer()`, never re-spelled as a local array.
 *    Two files can share one layer id (`~/.claude/settings.json` and
 *    `~/.claude/settings.local.json` are both `user`), so a same-layer tie is
 *    broken by cascade position: the later file wins.
 *
 * 2. THE AUTO-MODE EXCEPTION IS MODELLED, NOT HARD-CODED AWAY.
 *    `permissions.defaultMode: "auto"` is honoured only from the layers in
 *    `AUTO_MODE_TRUSTED_LAYERS`, because project and local files are
 *    repo-controllable — a cloned repo must not be able to grant itself auto
 *    mode. An untrusted "auto" is kept in the output and flagged
 *    `ignored: true` with a reason, rather than deleted: the panel exists to
 *    explain why a value you can see in a file is not the value in force. Any
 *    OTHER mode from project or local wins normally.
 *
 * 3. ARRAYS ARE ONE KEY, AND A FEW OF THEM UNION INSTEAD OF REPLACING.
 *    Flattening array elements into separate keys would render a merge that
 *    does not happen, so an array stays one row with per-element line numbers.
 *    But Claude Code does NOT resolve every array by precedence: the four
 *    permission lists (`permissions.allow`, `deny`, `ask`,
 *    `additionalDirectories`) and every `hooks.<Event>` registration are
 *    CONCATENATED across enterprise, user, project and local — a local
 *    `permissions.allow` adds to the user one, and hooks from every layer all
 *    fire, which is exactly what the panel's own Hooks section already shows.
 *    `MERGE_UNION_KEYS` records that. For those keys:
 *
 *      - `effectiveValue` is the concatenation of every non-ignored layer,
 *        weakest layer first, with exact duplicates collapsed to their first
 *        appearance, so a rule repeated in two files reads as one live rule;
 *      - every contributing entry is `overridden: false` + `contributes: true`,
 *        because nothing was overridden — declaring one winner is what made the
 *        Settings rows contradict the Hooks section;
 *      - the row carries `mergeKind: 'union'` and `winningLayer: null`, since a
 *        union HAS no winner, plus `contributingLayers` naming the layers that
 *        fed it. Scalars keep `mergeKind: 'replace'` and a real `winningLayer`.
 *
 *    Enterprise `permissions.deny` stays authoritative by construction: a union
 *    never drops a deny rule, so managed policy's entries are always live.
 *
 *    NOT unioned, deliberately: `enableAllProjectMcpServers` is a boolean and
 *    replaces like any other scalar; `enabledPlugins`, `env`, `sandbox`,
 *    `statusLine` and the other object containers are not special-cased —
 *    flattening already gives each of their CHILDREN its own row, so a child
 *    set only in the user layer survives a project layer that sets a different
 *    child, which is the per-key merge the CLI performs. Whether an
 *    object-typed child that is itself a list (an `enabledPlugins` marketplace
 *    array, say) unions is not documented anywhere I can verify, so it keeps
 *    replace semantics rather than inventing a merge the CLI may not do.
 *
 *    A union key written as a NON-array (a typo, a string where a list belongs)
 *    falls back to replace semantics: concatenating a scalar would fabricate a
 *    list the CLI never sees.
 *
 * 4. MASKING HAPPENS BEFORE THE VALUE ENTERS THE RESULT. Nothing downstream
 *    has to remember to mask; a full secret never exists in the returned
 *    object, so it cannot leak through JSON, SSE or a log line.
 *
 * READ ONLY: every read goes through `lib/source-file.mjs`. No write call
 * exists in this module.
 */
import { AUTO_MODE_TRUSTED_LAYERS, SETTINGS_CASCADE, layerById, resolveLayerPaths, winningLayer } from './layers.mjs';
import { lineOf } from './json-locate.mjs';
import { isSecretKey, looksLikeSecret, maskValue, redactText } from './mask.mjs';
import { readJsonFile, vscodeLink } from './source-file.mjs';

/**
 * Documented Claude Code setting keys, top-level and nested.
 *
 * The point is not completeness for its own sake: anything absent renders as
 * `known: false`, which is how a misspelled key that silently does nothing
 * (`permisions`, `modle`) becomes visible instead of looking configured.
 *
 * `$schema` is included deliberately — the CLI ignores it, but it is the
 * documented editor hint and flagging it would train users to ignore the badge.
 */
export const KNOWN_SETTING_KEYS = Object.freeze([
	'$schema',
	'apiKeyHelper',
	'autoMode',
	'autoUpdatesChannel',
	'cleanupPeriodDays',
	'disableBundledSkills',
	'disabledMcpjsonServers',
	'effortLevel',
	'enableAllProjectMcpServers',
	'enabledMcpjsonServers',
	'enabledPlugins',
	'env',
	'extraKnownMarketplaces',
	'forceLoginMethod',
	'hooks',
	'includeCoAuthoredBy',
	'model',
	'outputStyle',
	'permissions',
	'permissions.additionalDirectories',
	'permissions.allow',
	'permissions.ask',
	'permissions.defaultMode',
	'permissions.deny',
	'permissions.disableAutoMode',
	'sandbox',
	'skillOverrides',
	'statusLine',
	'theme',
]);

const KNOWN_SET = new Set(KNOWN_SETTING_KEYS);

/**
 * Documented object containers whose CHILDREN are NOT a closed vocabulary I can
 * check against: env var names, hook event names, skill ids, plugin ids, and the
 * sub-policies of `sandbox`, `statusLine` and `autoMode`.
 *
 * `permissions` is deliberately absent — its sub-keys ARE a closed set, and the
 * brief enumerates them, so `permissions.alow` must read as the typo it is.
 * Everywhere else, claiming a child is undocumented when I only lack its schema
 * would be a confident lie in the badge, which is worse than a missing badge.
 */
const FREE_FORM_ROOTS = new Set([
	'autoMode',
	'enabledPlugins',
	'env',
	'extraKnownMarketplaces',
	'hooks',
	'sandbox',
	'skillOverrides',
	'statusLine',
]);

/**
 * Owner-only model selectors, per the repo policy that only the owner picks
 * models. Applied to the leaf segment AND the full dotted path so `env.` prefixes
 * are covered. This is the pattern as specified; it is intentionally anchored,
 * so a name like `ANTHROPIC_SMALL_FAST_MODEL` does not match.
 */
const OWNER_ONLY_PATTERN = /^ANTHROPIC_MODEL|_AGENT_MODEL$|^EZ_ALL_AGENTS_MODEL$|_CLASSIFIER_MODEL$/;

/** The settings files each cascade layer contributes, weakest file first. */
const LAYER_SOURCE_PATHS = {
	user: (paths) => [paths.user.settings, paths.user.settingsLocal],
	project: (paths) => [paths.project.settings],
	local: (paths) => [paths.local.settings],
	enterprise: (paths) => [paths.enterprise.managedSettings],
};

const AUTO_MODE_KEY = 'permissions.defaultMode';
const AUTO_MODE_VALUE = 'auto';

/**
 * Keys Claude Code UNIONS across layers instead of resolving by precedence.
 *
 * The permission lists are enumerated because `permissions` is a closed
 * vocabulary. Hook registrations are matched by shape instead: the event names
 * (`PostToolUse`, `Stop`, `SessionStart`, …) are not a set this module can pin
 * down without going stale the next time the CLI adds one.
 */
const MERGE_UNION_KEYS = new Set([
	'permissions.additionalDirectories',
	'permissions.allow',
	'permissions.ask',
	'permissions.deny',
]);

/** `hooks.<Event>` — one level below `hooks`, which is where the arrays live. */
const HOOK_EVENT_KEY = /^hooks\.[^.]+$/;

/** True when the cascade concatenates this key rather than picking a winner. */
export function isUnionMergedKey(key) {
	if (typeof key !== 'string' || key.length === 0) return false;
	return MERGE_UNION_KEYS.has(key) || HOOK_EVENT_KEY.test(key);
}

export function isKnownSettingKey(key) {
	if (typeof key !== 'string' || key.length === 0) return false;
	if (KNOWN_SET.has(key)) return true;
	const root = key.split('.')[0];
	return root !== key && FREE_FORM_ROOTS.has(root);
}

export function isOwnerOnlyKey(key) {
	if (typeof key !== 'string' || key.length === 0) return false;
	const leaf = key.slice(key.lastIndexOf('.') + 1);
	return OWNER_ONLY_PATTERN.test(leaf) || OWNER_ONLY_PATTERN.test(key);
}

/**
 * Flattens a settings object to dotted leaf paths.
 *
 * Arrays are leaves (see decision 3). An EMPTY object is also a leaf, because
 * `{"permissions": {}}` is a real thing someone wrote and dropping it would
 * make the key vanish from the panel.
 *
 * @returns {Map<string, unknown>} dotted path -> raw value
 */
function flattenSettings(json) {
	const out = new Map();
	if (!json || typeof json !== 'object' || Array.isArray(json)) return out;

	const walk = (node, prefix) => {
		if (!node || typeof node !== 'object' || Array.isArray(node)) {
			out.set(prefix, node);
			return;
		}
		const entries = Object.entries(node);
		if (entries.length === 0) {
			out.set(prefix, node);
			return;
		}
		for (const [key, value] of entries) walk(value, prefix ? `${prefix}.${key}` : key);
	};

	for (const [key, value] of Object.entries(json)) walk(value, key);
	return out;
}

/**
 * Masks one scalar.
 *
 * A value whose KEY is secret-shaped inside `env` is replaced whole. A value
 * that merely CONTAINS a secret-shaped token (a hook command, a Bash permission
 * rule) is redacted in place, so the rule stays readable while the token does
 * not survive. Either way the original never reaches the caller.
 */
function maskScalar(value, secretName) {
	if (secretName) return { value: maskValue(value), secret: true };
	if (typeof value !== 'string' || !looksLikeSecret(value)) return { value, secret: false };
	const bareToken = !/\s/.test(value);
	return { value: bareToken ? maskValue(value) : redactText(value), secret: true };
}

/** Masks a leaf value, element by element when it is an array. */
function maskLeaf(key, value) {
	const leaf = key.slice(key.lastIndexOf('.') + 1);
	const underEnv = key === 'env' || key.startsWith('env.');
	const secretName = underEnv && isSecretKey(leaf);

	if (!Array.isArray(value)) return maskScalar(value, secretName);

	let secret = false;
	const masked = value.map((item) => {
		const result = maskScalar(item, secretName);
		if (result.secret) secret = true;
		return result.value;
	});
	return { value: masked, secret };
}

/**
 * Why an entry present in a file is not in force. Returns null when the entry
 * competes normally — including a project or local `defaultMode` of any mode
 * other than "auto", which wins on authority like any other key.
 */
function ignoredReasonFor(key, rawValue, layerId) {
	if (key !== AUTO_MODE_KEY || rawValue !== AUTO_MODE_VALUE) return null;
	if (AUTO_MODE_TRUSTED_LAYERS.includes(layerId)) return null;
	return (
		`${AUTO_MODE_KEY} "${AUTO_MODE_VALUE}" is honoured only from ` +
		`${AUTO_MODE_TRUSTED_LAYERS.join(' or ')} settings. The ${layerId} layer is ` +
		'repo-controllable, so Claude Code ignores this entry and the trusted value stands.'
	);
}

/**
 * Per-element deep links for an array-valued key.
 *
 * `layer` and `path` travel with each element because a union row's elements
 * come from several files at once; without them a merged list could not say
 * which file each rule actually lives in.
 */
function elementsFor(key, maskedValue, source) {
	if (!Array.isArray(maskedValue)) return null;
	return maskedValue.map((value, index) => {
		const line = lineOf(source.lineIndex, `${key}[${index}]`);
		return { index, value, layer: source.layerId, path: source.path, line, link: vscodeLink(source.path, line) };
	});
}

/**
 * Concatenates every contributing layer's elements, weakest first, dropping
 * exact duplicates. Objects (hook registrations) are compared by their JSON
 * form, which is what "exact duplicate" means for a value read out of a file.
 */
function unionOf(contenders) {
	const seen = new Set();
	const value = [];
	const elements = [];
	for (const entry of contenders) {
		for (const element of entry.elements ?? []) {
			const fingerprint = JSON.stringify(element.value) ?? String(element.value);
			if (seen.has(fingerprint)) continue;
			seen.add(fingerprint);
			value.push(element.value);
			elements.push({ ...element, index: elements.length });
		}
	}
	return { value, elements };
}

/** Layer ids in cascade order, each named once. */
function layerIdsOf(entries) {
	const ids = [];
	for (const entry of entries) if (!ids.includes(entry.layer)) ids.push(entry.layer);
	return ids;
}

/** Reads one settings file and flattens it. Failures stay visible, never faked. */
function readSource(layerId, absPath) {
	const file = readJsonFile(absPath);
	const layer = layerById(layerId);
	let parseError = file.parseError ? redactText(file.parseError) : null;

	// Parsed, but not a settings object. Structurally unusable, so it is reported
	// the same way a syntax error is rather than silently contributing nothing.
	if (!parseError && file.json !== null && (typeof file.json !== 'object' || Array.isArray(file.json))) {
		parseError = `settings root must be a JSON object, found ${Array.isArray(file.json) ? 'array' : typeof file.json}`;
	}

	const flat = parseError ? new Map() : flattenSettings(file.json);

	return {
		layerId,
		path: absPath,
		lineIndex: file.lineIndex,
		flat,
		row: {
			id: layerId,
			label: layer?.label ?? layerId,
			path: absPath,
			exists: file.exists,
			readable: file.readable,
			parseError,
			error: file.error ? redactText(file.error) : null,
			keyCount: flat.size,
		},
	};
}

/**
 * Merges the settings cascade for one project.
 *
 * @param {{home: string, projectRoot: string}} options
 * @returns {{layers: object[], keys: object[], conflicts: object[]}}
 */
export function mergeSettings(options) {
	const { home, projectRoot } = options ?? {};
	if (typeof home !== 'string' || typeof projectRoot !== 'string') {
		throw new TypeError('mergeSettings requires absolute home and projectRoot');
	}

	const paths = resolveLayerPaths({ home, projectRoot });

	// Source order comes from SETTINGS_CASCADE (weakest first) so this module
	// never re-declares precedence; it only resolves it.
	const sources = [];
	for (const layerId of SETTINGS_CASCADE) {
		const forLayer = LAYER_SOURCE_PATHS[layerId];
		if (!forLayer) continue;
		for (const absPath of forLayer(paths)) sources.push(readSource(layerId, absPath));
	}

	// key -> entries, collected in cascade order so index doubles as tie-break.
	const byKey = new Map();
	for (const source of sources) {
		for (const [key, rawValue] of source.flat) {
			const { value, secret } = maskLeaf(key, rawValue);
			const line = lineOf(source.lineIndex, key);
			const ignoredReason = ignoredReasonFor(key, rawValue, source.layerId);
			const entry = {
				layer: source.layerId,
				value,
				path: source.path,
				line,
				link: vscodeLink(source.path, line),
				overridden: false,
				contributes: false,
				ignored: ignoredReason !== null,
				ignoredReason,
			};
			const elements = elementsFor(key, value, source);
			if (elements) entry.elements = elements;

			if (!byKey.has(key)) byKey.set(key, { entries: [], secret: false });
			const bucket = byKey.get(key);
			bucket.entries.push(entry);
			if (secret) bucket.secret = true;
		}
	}

	const keys = [];
	for (const [key, bucket] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const contenders = bucket.entries.filter((entry) => !entry.ignored);
		// A union only happens when every contribution really is a list; a key
		// written as a scalar falls back to precedence instead of being merged.
		const union =
			isUnionMergedKey(key) && contenders.length > 0 && contenders.every((entry) => Array.isArray(entry.value));

		if (union) {
			// Nothing is overridden here: every layer's entries are live at once.
			for (const entry of contenders) {
				entry.overridden = false;
				entry.contributes = true;
			}
			const merged = unionOf(contenders);
			keys.push({
				key,
				effectiveValue: merged.value,
				mergeKind: 'union',
				winningLayer: null,
				contributingLayers: layerIdsOf(contenders),
				known: isKnownSettingKey(key),
				ownerOnly: isOwnerOnlyKey(key),
				secret: bucket.secret,
				perLayer: bucket.entries,
				elements: merged.elements,
			});
			continue;
		}

		const winnerLayer = winningLayer(contenders.map((entry) => entry.layer));
		// Last source of the winning layer: same-layer ties go to the later file.
		const winner = winnerLayer ? [...contenders].reverse().find((entry) => entry.layer === winnerLayer) : null;

		for (const entry of contenders) {
			entry.overridden = entry !== winner;
			entry.contributes = entry === winner;
		}

		keys.push({
			key,
			effectiveValue: winner ? winner.value : null,
			mergeKind: 'replace',
			winningLayer: winnerLayer,
			contributingLayers: winner ? [winner.layer] : [],
			known: isKnownSettingKey(key),
			ownerOnly: isOwnerOnlyKey(key),
			secret: bucket.secret,
			perLayer: bucket.entries,
			elements: winner?.elements ?? null,
		});
	}

	return {
		layers: sources.map((source) => source.row),
		keys,
		// Same objects as `keys`, not copies, so the UI can highlight in place.
		// Union keys are excluded on purpose: several layers CONTRIBUTING to one
		// merged list is not a conflict — nothing was lost, so flagging it would
		// send someone hunting for an override that never happened.
		conflicts: keys.filter((row) => row.mergeKind !== 'union' && row.perLayer.length > 1),
	};
}
