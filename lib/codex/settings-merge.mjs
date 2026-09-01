/**
 * The Codex config cascade — which value is actually LIVE.
 *
 * Codex counterpart of `../settings-merge.mjs`, and it returns the same three
 * top-level fields (`layers`, `keys`, `conflicts`) with the same per-key field
 * names, so `public/app.js`'s `settings` adapter renders it with no branch of
 * its own.
 *
 * Five decisions carry the module:
 *
 * 1. PRECEDENCE COMES FROM `layers.mjs`, NOT FROM HERE.
 *    `CODEX_SETTINGS_CASCADE` is `['user', 'profile', 'project', 'cli']`,
 *    weakest first, confirmed against Codex 0.149.1's own loader order. This
 *    module appends exactly one step to it — `runtime` — and says why below.
 *    Nothing else about ordering is re-spelled here.
 *
 * 2. A PROFILE IS SHOWN BUT NEVER WINS.
 *    `$CODEX_HOME/<name>.config.toml` only applies when the session was started
 *    with `--profile <name>`. A read-only panel cannot know which profile (if
 *    any) a given session picked, so every profile entry is emitted with
 *    `ignored: true` and a reason naming the flag that would activate it. The
 *    layer row still exists: the whole point of the panel is to show what a
 *    file WOULD change, not to hide files that are dormant right now.
 *
 * 3. THE PROJECT DENYLIST IS MODELLED, NOT DELETED.
 *    Codex refuses a fixed set of keys from a project's `.codex/config.toml`
 *    (base URLs, provider definitions, `notify`, profiles, telemetry…) because
 *    a cloned repo must not be able to repoint the CLI at another endpoint.
 *    Those entries stay in the output flagged `ignored: true`, for the same
 *    reason the Claude module keeps an untrusted `auto` mode: "this line exists
 *    and does nothing" is the finding.
 *
 * 4. THE RUNTIME TURN CONTEXT OUTRANKS EVERY FILE.
 *    A session records what it is ACTUALLY running in each rollout's
 *    `turn_context` record — model, effort, approval policy, sandbox mode,
 *    permission profile. `/model`, `/approve`, a `-c` override on the command
 *    line and a resumed thread's stored settings all land there and in no file
 *    on disk. So the newest rollout for this project contributes a `runtime`
 *    layer that wins for exactly the keys it records, and for no others: a key
 *    absent from `turn_context` gets no runtime entry rather than a fabricated
 *    one. When no rollout matches, the layer row says so and every file value
 *    stands.
 *
 *    The rollout is read by STREAMING it line by line (`node:readline` over a
 *    `fs.createReadStream`) and keeping only the tail-most `turn_context`'s six
 *    scalars. Rollouts reach 100k+ lines; `readFileSync` on one would stall the
 *    panel. That is also why this export is async.
 *
 * 5. `known` IS ALWAYS null, DELIBERATELY.
 *    Claude Code publishes a settings schema, so `known: false` there means
 *    "this key is a typo that does nothing". Codex publishes no such schema the
 *    panel can check against, so claiming a key is unknown would be a guess
 *    rendered as a red badge. `null` renders no badge at all, and `notes`
 *    carries the reason in words.
 *
 * READ ONLY: every read goes through `../source-file.mjs` or a read stream. No
 * write call exists in this module, and `auth.json` (`NEVER_READ`) is never
 * opened — nothing here ever builds a path to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CODEX_SETTINGS_CASCADE, codexLayerById, resolveCodexPaths } from './layers.mjs';
import { flattenToml, lineOfTomlKey, parseToml } from './toml.mjs';
import { isSecretKey, looksLikeSecret, maskValue, redactText } from '../mask.mjs';
import { readSourceFile, vscodeLink } from '../source-file.mjs';

/**
 * The full merge order: the shared cascade plus the one step that has no file.
 *
 * `runtime` is appended HERE and not in `layers.mjs` because it is not a config
 * layer Codex loads — it is the observed result of loading them, plus whatever
 * the session changed afterwards. It outranks everything for the keys it knows.
 */
export const CODEX_MERGE_ORDER = Object.freeze([...CODEX_SETTINGS_CASCADE, 'runtime']);

/**
 * Keys Codex refuses to take from a project's `.codex/config.toml`.
 *
 * Root-level names, exact dotted keys, and one whole table are kept apart
 * because the contract enumerates the first two and describes the third only as
 * "realtime endpoint overrides". Denying the whole `realtime` table is the
 * conservative reading; `PROJECT_DENIED_TABLE_NOTE` says out loud that the
 * exact sub-key list is unverified rather than implying it was checked.
 */
const PROJECT_DENIED_ROOTS = new Set([
	'apps_mcp_product_sku',
	'chatgpt_base_url',
	'model_provider',
	'model_providers',
	'notify',
	'openai_base_url',
	'otel',
	'profile',
	'profiles',
	'responses_api_metadata',
]);

const PROJECT_DENIED_KEYS = new Set(['features.respect_system_proxy']);

const PROJECT_DENIED_TABLE = 'realtime';

const PROJECT_DENIED_TABLE_NOTE =
	'the loader denies "realtime endpoint overrides" from project config; the exact sub-key list is unverified, ' +
	'so the whole [realtime] table is reported as denied';

/**
 * Header tables, masked WHOLESALE.
 *
 * An HTTP header carrying authorization is secret whatever it is called:
 * `Authorization = "Bearer …"` matches no secret-looking key name and no vendor
 * value shape, so name-and-shape masking alone leaks it. Header values are
 * never interesting to read, so masking all of them costs nothing.
 *
 * `env` and `env_vars` deliberately do NOT get this treatment: an MCP server's
 * env block is mostly ordinary configuration (feature flags, backend lists) and
 * blanking it would hide the settings the panel exists to show. Those fall back
 * to the same name-or-shape rule the Claude module uses.
 */
const BLANKET_SECRET_TABLES = new Set(['env_http_headers', 'http_headers']);

/**
 * `bearer_token_env_var` names the variable that holds a token; it is not the
 * token. Masking it would hide a useful fact and protect nothing.
 */
const ENV_NAME_SUFFIX = /_env_var$|_env_key$|_env_name$/;

/** How many rollout files to peek at before giving up on a cwd match. */
const MAX_ROLLOUTS_PROBED = 25;

/**
 * Which `turn_context` field feeds which config key.
 *
 * `sandbox_mode` and `permission_profile` are read out of nested objects
 * because the rollout records the resolved POLICY (with its writable roots and
 * every allowed path) where the config key holds only the mode name. Rendering
 * the whole policy object in a settings row would be a wall of paths, so the
 * discriminant is what travels and the rollout link is how you see the rest.
 */
const RUNTIME_KEYS = [
	{ key: 'model', from: (p) => p.model },
	{ key: 'model_reasoning_effort', from: (p) => p.effort },
	{ key: 'approval_policy', from: (p) => p.approval_policy },
	{ key: 'sandbox_mode', from: (p) => p.sandbox_policy?.type },
	{ key: 'service_tier', from: (p) => p.service_tier },
	{ key: 'permission_profile', from: (p) => p.permission_profile?.type ?? p.permission_profile },
];

const RUNTIME_NOTE =
	'Observed in the newest rollout for this project. A session changes these through /model, /approve, a resumed ' +
	'thread or `-c key=value`, none of which touch a file — so this is the effective value and the config files below ' +
	'are what a NEW session would start from.';

/** True when `value` is a scalar this module can safely render inline. */
function isRenderable(value) {
	return value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value));
}

/** The leaf segment of a dotted TOML path. */
function leafOf(pathSegs) {
	return pathSegs.length > 0 ? String(pathSegs[pathSegs.length - 1]) : '';
}

/** True when this leaf sits inside a table whose every value is authorization. */
function inBlanketSecretTable(pathSegs) {
	return pathSegs.slice(0, -1).some((segment) => BLANKET_SECRET_TABLES.has(String(segment)));
}

/**
 * Masks one scalar. A value inside a secret table (or under a secret-looking
 * key name) is replaced whole; a value that merely CONTAINS a secret-shaped
 * token — a `notify` argv entry, an MCP command line — is redacted in place so
 * the surrounding text stays readable and the token does not survive.
 */
function maskScalar(value, secretName) {
	if (secretName) return { value: maskValue(value), secret: true };
	if (typeof value !== 'string' || !looksLikeSecret(value)) return { value, secret: false };
	const bareToken = !/\s/.test(value);
	return { value: bareToken ? maskValue(value) : redactText(value), secret: true };
}

/** Masks a leaf value, element by element when it is an array. */
function maskLeaf(pathSegs, value) {
	const leaf = leafOf(pathSegs);
	const secretName = inBlanketSecretTable(pathSegs) || (isSecretKey(leaf) && !ENV_NAME_SUFFIX.test(leaf));

	if (!Array.isArray(value)) return maskScalar(value, secretName);

	let secret = false;
	const masked = value.map((item) => {
		const result = maskScalar(item, secretName);
		if (result.secret) secret = true;
		return result.value;
	});
	return { value: masked, secret };
}

/** Why an entry that exists in a file is not in force. null when it competes. */
function ignoredReasonFor(layerId, dottedKey, pathSegs, profileName) {
	if (layerId === 'profile') {
		return `profile "${profileName}" applies only with --profile ${profileName}`;
	}
	if (layerId !== 'project') return null;
	const root = String(pathSegs[0] ?? '');
	if (PROJECT_DENIED_ROOTS.has(root) || PROJECT_DENIED_KEYS.has(dottedKey)) return 'denied from project config';
	if (root === PROJECT_DENIED_TABLE) return `denied from project config — ${PROJECT_DENIED_TABLE_NOTE}`;
	return null;
}

/**
 * Reads one TOML config file and flattens it to dotted keys.
 *
 * A parse error does not discard the keys the parser DID recover: `parseToml`
 * recovers line by line, so a file with one bad line still reports the rest,
 * with the error visible on the layer row.
 */
function readTomlSource({ layerId, absPath, profileName = null, note = null }) {
	const file = readSourceFile(absPath);
	const layer = codexLayerById(layerId);
	const parsed =
		file.readable && file.content != null ? parseToml(file.content) : { value: {}, locations: new Map(), errors: [] };
	const entries = file.readable ? flattenToml(parsed.value) : [];
	const tomlError =
		parsed.errors.length > 0 ? parsed.errors.map((error) => `line ${error.line}: ${error.message}`).join('; ') : null;

	return {
		layerId,
		path: absPath,
		profileName,
		locations: parsed.locations,
		entries,
		row: {
			// `id` matches the Claude layer row; `layer` is the name every other
			// Codex row uses. Both are emitted so neither reader has to translate.
			id: layerId,
			layer: layerId,
			// `profile` is not in CODEX_LAYERS — it is a cascade step, not a place
			// files live — so it names itself here rather than falling back to a
			// bare id.
			label: layer?.label ?? (profileName ? `Profile (--profile ${profileName})` : layerId),
			path: absPath,
			exists: file.exists,
			readable: file.readable,
			error: [file.error ? redactText(file.error) : null, tomlError].filter(Boolean).join(' | ') || null,
			parseError: tomlError,
			keyCount: entries.length,
			line: file.readable ? 1 : null,
			note,
		},
	};
}

/**
 * Every `<codexHome>/<name>.config.toml`, sorted by name.
 *
 * `config.toml` itself is excluded — it is the user layer, not a profile. A
 * missing or unreadable CODEX_HOME yields an empty list rather than a throw:
 * the panel must still render the layers it CAN see.
 */
function discoverProfiles(codexHomeDir) {
	let names;
	try {
		names = fs.readdirSync(codexHomeDir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith('.config.toml') && name !== 'config.toml')
		.sort()
		.map((name) => ({ name: name.slice(0, -'.config.toml'.length), path: path.join(codexHomeDir, name) }));
}

/** Every `*.jsonl` under `sessionsDir`, newest mtime first. Never throws. */
function collectRolloutFiles(sessionsDir) {
	const found = [];
	const walk = (dir) => {
		let dirEntries;
		try {
			dirEntries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of dirEntries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.jsonl')) continue;
			try {
				found.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
			} catch {
				/* vanished between readdir and stat — simply not a candidate */
			}
		}
	};
	walk(sessionsDir);
	return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.path);
}

/**
 * Streams ONE rollout and returns its tail-most `turn_context`, or null when
 * the file belongs to another project.
 *
 * Two cheap guards keep this affordable on a 100k-line file: the stream is torn
 * down as soon as `session_meta` proves the cwd does not match, and only lines
 * that textually contain the record type are handed to `JSON.parse`.
 */
function scanRollout(filePath, projectRoot) {
	return new Promise((resolve) => {
		let stream;
		try {
			stream = fs.createReadStream(filePath, { encoding: 'utf8' });
		} catch {
			resolve(null);
			return;
		}
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

		let lineNumber = 0;
		let cwdChecked = false;
		let cwdMatched = false;
		let latest = null;
		let done = false;

		const finish = (result) => {
			if (done) return;
			done = true;
			rl.close();
			stream.destroy();
			resolve(result);
		};

		rl.on('line', (line) => {
			lineNumber += 1;
			if (done || line.length === 0) return;

			if (!cwdChecked && line.includes('"session_meta"')) {
				let cwd = null;
				try {
					const record = JSON.parse(line);
					if (record?.type !== 'session_meta') return;
					cwd = record?.payload?.cwd ?? null;
				} catch {
					return;
				}
				cwdChecked = true;
				cwdMatched = typeof cwd === 'string' && (cwd === projectRoot || cwd.startsWith(`${projectRoot}${path.sep}`));
				if (!cwdMatched) finish(null);
				return;
			}

			// A turn_context is only ever accepted once session_meta has PROVEN this
			// project's cwd. Ordered before session_meta, or in a file where
			// session_meta never resolves (missing or fails to parse), it is simply
			// dropped -- accepting it here would let another project's runtime state
			// leak through unverified.
			if (!cwdChecked || !cwdMatched) return;
			if (!line.includes('"turn_context"')) return;
			try {
				const record = JSON.parse(line);
				if (record?.type !== 'turn_context' || !record.payload) return;
				latest = { line: lineNumber, payload: record.payload };
			} catch {
				/* a truncated tail line is not a reason to lose the whole scan */
			}
		});

		rl.on('close', () => finish(latest ? { path: filePath, ...latest } : null));
		stream.on('error', () => finish(null));
	});
}

/**
 * The newest rollout whose session cwd is this project, with its tail-most
 * `turn_context`. Returns `{ found: false, reason }` when there is none — never
 * a fabricated runtime state.
 */
async function findRuntimeContext({ sessionsDir, projectRoot }) {
	const files = collectRolloutFiles(sessionsDir);
	if (files.length === 0) {
		return { found: false, reason: `no rollout files under ${sessionsDir}`, scanned: 0 };
	}
	const probe = files.slice(0, MAX_ROLLOUTS_PROBED);
	for (const filePath of probe) {
		const result = await scanRollout(filePath, projectRoot);
		if (result) return { found: true, ...result, scanned: probe.length };
	}
	return {
		found: false,
		reason:
			`none of the ${probe.length} newest rollouts under ${sessionsDir} ran in ${projectRoot}` +
			(files.length > probe.length ? ` (${files.length - probe.length} older ones not probed)` : ''),
		scanned: probe.length,
	};
}

/** Cascade position, used to resolve a winner. Unknown layer ids sort weakest. */
function authorityOf(layerId) {
	const index = CODEX_MERGE_ORDER.indexOf(layerId);
	return index === -1 ? -1 : index;
}

/**
 * Merges the Codex config cascade for one project.
 *
 * @param {{home: string, projectRoot: string, codexHome?: string}} options
 * @returns {Promise<{layers: object[], keys: object[], conflicts: object[], notes: string[]}>}
 */
export async function mergeCodexSettings(options) {
	const { home, projectRoot, codexHome } = options ?? {};
	if (typeof home !== 'string' || typeof projectRoot !== 'string') {
		throw new TypeError('mergeCodexSettings requires absolute home and projectRoot');
	}

	const paths = resolveCodexPaths({ home, projectRoot, codexHome });
	const codexHomeDir = paths.user.dir;

	const sources = [];
	sources.push(
		readTomlSource({
			layerId: 'user',
			absPath: paths.user.config,
			note: 'Personal defaults. Every session reads this one.',
		}),
	);
	for (const profile of discoverProfiles(codexHomeDir)) {
		sources.push(
			readTomlSource({
				layerId: 'profile',
				absPath: profile.path,
				profileName: profile.name,
				note: `Dormant unless the session was started with --profile ${profile.name}.`,
			}),
		);
	}
	sources.push(
		readTomlSource({
			layerId: 'project',
			absPath: paths.project.config,
			note: 'Loaded only when this project is trusted, and a fixed set of keys is denied from it.',
		}),
	);

	const layerRows = sources.map((source) => source.row);

	// `-c key=value` and the in-session UI overrides have no file at all. The row
	// exists so the reader knows the cascade does not end at the project layer.
	layerRows.push({
		id: 'cli',
		layer: 'cli',
		label: codexLayerById('cli')?.label ?? 'CLI / session override',
		path: null,
		exists: false,
		readable: false,
		error: null,
		parseError: null,
		keyCount: 0,
		line: null,
		note: '-c key=value and UI overrides are per-session and not on disk',
	});

	const runtime = await findRuntimeContext({ sessionsDir: paths.user.sessionsDir, projectRoot });
	const runtimeEntries = [];
	if (runtime.found) {
		for (const spec of RUNTIME_KEYS) {
			const value = spec.from(runtime.payload);
			if (!isRenderable(value)) continue;
			runtimeEntries.push({ key: spec.key, pathSegs: [spec.key], value });
		}
	}
	layerRows.push({
		id: 'runtime',
		layer: 'runtime',
		label: 'Runtime (observed)',
		path: runtime.found ? runtime.path : null,
		exists: runtime.found,
		readable: runtime.found,
		error: null,
		parseError: null,
		keyCount: runtimeEntries.length,
		line: runtime.found ? runtime.line : null,
		note: runtime.found
			? `Tail-most turn_context of the newest rollout for this project. ${RUNTIME_NOTE}`
			: `No runtime state observed — ${runtime.reason}. Every value below is what the files say.`,
	});

	// key -> entries, collected weakest-layer-first so file order doubles as a
	// same-layer tie-break (a later profile file beats an earlier one).
	const byKey = new Map();
	const push = (key, entry, secret) => {
		if (!byKey.has(key)) byKey.set(key, { entries: [], secret: false });
		const bucket = byKey.get(key);
		bucket.entries.push(entry);
		if (secret) bucket.secret = true;
	};

	for (const source of sources) {
		for (const leaf of source.entries) {
			const { value, secret } = maskLeaf(leaf.path, leaf.value);
			const line = lineOfTomlKey(source.locations, leaf.path);
			const ignoredReason = ignoredReasonFor(source.layerId, leaf.key, leaf.path, source.profileName);
			push(
				leaf.key,
				{
					layer: source.layerId,
					value,
					path: source.path,
					line,
					link: vscodeLink(source.path, line),
					overridden: false,
					contributes: false,
					ignored: ignoredReason !== null,
					ignoredReason,
					profile: source.profileName,
				},
				secret,
			);
		}
	}

	for (const entry of runtimeEntries) {
		const { value, secret } = maskLeaf(entry.pathSegs, entry.value);
		push(
			entry.key,
			{
				layer: 'runtime',
				value,
				path: runtime.path,
				line: runtime.line,
				link: vscodeLink(runtime.path, runtime.line),
				overridden: false,
				contributes: false,
				ignored: false,
				ignoredReason: null,
				note: RUNTIME_NOTE,
			},
			secret,
		);
	}

	const keys = [];
	for (const [key, bucket] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const contenders = bucket.entries.filter((entry) => !entry.ignored);

		// Highest cascade position wins; a same-position tie goes to the later
		// file, which is why `contenders` is scanned in reverse.
		let winner = null;
		for (const entry of [...contenders].reverse()) {
			if (!winner || authorityOf(entry.layer) > authorityOf(winner.layer)) winner = entry;
		}
		for (const entry of contenders) {
			entry.overridden = entry !== winner;
			entry.contributes = entry === winner;
		}

		keys.push({
			key,
			effectiveValue: winner ? winner.value : null,
			// Every Codex config key resolves by precedence. No key is known to
			// union across layers the way Claude's permission lists do, and
			// inventing one would render a merge the CLI never performs.
			mergeKind: 'replace',
			winningLayer: winner ? winner.layer : null,
			contributingLayers: winner ? [winner.layer] : [],
			// See decision 5: Codex ships no schema this panel can check a key
			// against, so "unknown key" is never claimed.
			known: null,
			secret: bucket.secret,
			perLayer: bucket.entries,
		});
	}

	return {
		layers: layerRows,
		keys,
		// Same objects as `keys`, not copies, so the UI can highlight in place.
		// A key is only a conflict when two layers that BOTH apply set it — a
		// dormant profile or a denied project key was never in the running.
		conflicts: keys.filter((row) => row.perLayer.filter((entry) => !entry.ignored).length > 1),
		notes: [
			'known is null on every row: Codex publishes no settings schema this panel can verify a key against, ' +
				'so a misspelled key cannot be told from a valid one here.',
			`Profile files are listed but never win: ${CODEX_SETTINGS_CASCADE.join(' < ')} is the file cascade, and a ` +
				'profile layer only applies to a session started with --profile <name>, which no file records.',
			runtime.found
				? `Runtime state read from ${runtime.path} (line ${runtime.line}).`
				: `No runtime state: ${runtime.reason}.`,
		],
	};
}
