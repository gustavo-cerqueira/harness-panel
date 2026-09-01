/**
 * Codex hooks: every declared hook, and whether Codex will actually RUN it.
 *
 * Codex counterpart of `../hooks-scan.mjs`. It returns the same array of rows
 * with the same field names, so `public/app.js`'s `hooks` adapter renders it
 * unchanged, and adds the fact that has no Claude equivalent: trust.
 *
 * WHY TRUST IS THE HEADLINE. Codex does not run a hook just because it is
 * declared. It runs a hook whose canonical digest matches the one recorded in
 * `config.toml` under `[hooks.state."<key>"] trusted_hash`, written when the
 * user approved it through `/hooks`. Edit the command afterwards and the hook
 * is discovered, listed, and silently never executed. Nothing in `hooks.json`
 * says so. A panel that showed the declaration alone would be describing a
 * guardrail that is not guarding anything, which is exactly the failure mode
 * this panel exists to catch — so `trusted` is computed, not assumed.
 *
 * THE DIGEST IS REPRODUCED, NOT TRUSTED SECOND-HAND. `computeHookTrustHash`
 * implements Codex 0.149.1's canonicalization:
 *
 *   key      = "<absolute hooks source path>:<snake_case event>:<group index>:<handler index>"
 *   identity = { event_name, [matcher], hooks: [ <one normalized handler> ] }
 *   handler  = { type, command, async (default false), timeout (default 600;
 *                SessionEnd defaults to 1 and is capped at 3), statusMessage
 *                when present }, with `commandWindows` dropped after the
 *                platform command is selected
 *   digest   = "sha256:" + sha256(JSON.stringify(recursively key-sorted identity))
 *
 * Verified against all eight hashes this machine has recorded (four in
 * `~/.codex/hooks.json`, four in the repo's `.codex/hooks.json`) — see the
 * reality test. The five of those eight that carry a matcher all hash WITH the
 * matcher inside the identity object, which is what pins that half of the rule
 * down. No group on a matcher-less event declares a matcher here, so
 * `MATCHER_EVENTS` is the contract's list rather than something this machine
 * could prove; a matcher is emitted only when the group declares one AND the
 * event is on that list, and the note says which half is verified.
 *
 * A handler property outside the normalized set (a `shell` key, say) is hashed
 * as if absent, because the contract does not record it. If a hook ever reads
 * `trusted: false` here while Codex plainly runs it, THIS normalization is the
 * thing to fix — never the badge.
 *
 * LINKED WORKTREES. For a linked worktree Codex substitutes the MAIN
 * checkout's `.codex` declarations, which is why the recorded trust keys name
 * the main checkout's path and not the worktree's. So the project source is
 * resolved through `git rev-parse --git-common-dir` (read-only, no shell, with
 * a timeout) and the row says which file it really read.
 *
 * READ ONLY, and deliberately inert: this module resolves a hook's script to a
 * real path and stats it, but never opens or runs it. The one child process it
 * spawns is `git rev-parse`, which reads repository metadata and writes
 * nothing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lineOf } from '../json-locate.mjs';
import { redactText } from '../mask.mjs';
import { readJsonFile, vscodeLink } from '../source-file.mjs';
import { resolveCodexPaths } from './layers.mjs';
import { lineOfTomlKey, parseToml } from './toml.mjs';

/**
 * Hook events Codex 0.149.1 dispatches. An event outside this list still gets a
 * row — a typo in `hooks.json` is a finding, not a reason to hide the line —
 * flagged through `eventKnown: false`.
 */
export const CODEX_HOOK_EVENTS = Object.freeze([
	'PreToolUse',
	'PermissionRequest',
	'PostToolUse',
	'PreCompact',
	'PostCompact',
	'SessionStart',
	'SessionEnd',
	'UserPromptSubmit',
	'SubagentStart',
	'SubagentStop',
	'Stop',
]);

/**
 * Events whose groups carry a matcher (a regex over the tool/event name).
 * `SessionStart`, `SessionEnd`, `UserPromptSubmit` and `Stop` have nothing to
 * match on, so their identity object omits the field entirely.
 */
export const MATCHER_EVENTS = Object.freeze([
	'PreToolUse',
	'PermissionRequest',
	'PostToolUse',
	'SubagentStart',
	'SubagentStop',
	'PreCompact',
	'PostCompact',
]);

const MATCHER_EVENT_SET = new Set(MATCHER_EVENTS);

/** Codex's default handler timeout, in seconds. */
const DEFAULT_TIMEOUT_SEC = 600;

/** `SessionEnd` runs while the CLI is tearing down, so it is on a short leash. */
const SESSION_END_DEFAULT_TIMEOUT_SEC = 1;
const SESSION_END_MAX_TIMEOUT_SEC = 3;

/** How long `git rev-parse` may take before the worktree question is dropped. */
const GIT_TIMEOUT_MS = 2000;

/**
 * Where Codex's guardrails stop watching, in the same static-export form as the
 * Claude module. Exposed independently of any scan result so the UI can render
 * the whole list; individual rows additionally tag themselves through
 * `escapeHatches`.
 */
export const CODEX_KNOWN_ESCAPE_HATCHES = [
	{
		id: 'untrusted-hook-silently-skipped',
		title: 'An untrusted hook is discovered, listed, and never run',
		detail:
			'Codex runs a hook only when its canonical digest matches the trusted_hash recorded in config.toml. ' +
			'Editing the command invalidates that hash, after which the hook is skipped with no error and no trace ' +
			'in hooks.json. Re-approve it through /hooks to make it run again.',
		appliesTo: ['*'],
	},
	{
		id: 'codex-hooks-tool-scoped',
		title: 'PreToolUse / PostToolUse gates only see tool calls',
		detail:
			'A policy gate wired to PreToolUse or PostToolUse observes the tool call only. A write performed inside a ' +
			'shell command goes around it entirely — the same limit the Claude-side require-spec-lock.sh has. It stops ' +
			'drift, not intent.',
		appliesTo: ['PreToolUse', 'PostToolUse'],
	},
	{
		id: 'git-hookspath-bypass',
		title: '`git -c core.hooksPath=...` skips the repo pre-commit gate',
		detail:
			'`git -c core.hooksPath=...` silently skips the repo pre-commit gate, leaving none of the trace ' +
			'that `--no-verify` implies. No Codex hook event fires on a git commit.',
		appliesTo: ['pre-commit'],
	},
];

/** Scripts this repo uses as policy gates — the rows worth tagging tool-scoped. */
const GATE_SCRIPTS = ['require-spec-lock.sh', 'codex-gate-enforce.py', 'block-apps-barrel-export.sh'];

/** `PreToolUse` -> `pre_tool_use`, the form the trust key uses. */
export function snakeCaseEvent(event) {
	return String(event ?? '')
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toLowerCase();
}

/** The `[hooks.state."<key>"]` table name for one declared handler. */
export function hookTrustKey(sourcePath, event, groupIndex, hookIndex) {
	return `${sourcePath}:${snakeCaseEvent(event)}:${groupIndex}:${hookIndex}`;
}

/** Recursively sorts object keys; array order is meaningful and preserved. */
function sortKeysDeep(value) {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value && typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
		return out;
	}
	return value;
}

/** The command Codex would run on THIS platform. `commandWindows` never ships. */
function platformCommand(handler) {
	if (
		process.platform === 'win32' &&
		typeof handler?.commandWindows === 'string' &&
		handler.commandWindows.length > 0
	) {
		return handler.commandWindows;
	}
	return typeof handler?.command === 'string' ? handler.command : null;
}

/** Applies Codex's timeout defaults and the SessionEnd cap. */
function effectiveTimeout(event, declared) {
	if (event === 'SessionEnd') {
		const base = typeof declared === 'number' ? declared : SESSION_END_DEFAULT_TIMEOUT_SEC;
		return Math.min(base, SESSION_END_MAX_TIMEOUT_SEC);
	}
	return typeof declared === 'number' ? declared : DEFAULT_TIMEOUT_SEC;
}

/**
 * The canonical digest Codex compares against `trusted_hash`.
 *
 * @param {{event: string, matcher: string|null, handler: object}} input
 * @returns {{hash: string|null, canonical: string|null, reason: string|null}}
 *   `hash` is null when the handler has no command — Codex rejects those, so
 *   there is nothing to be trusted.
 */
export function computeHookTrustHash({ event, matcher, handler }) {
	const command = platformCommand(handler);
	if (!command) return { hash: null, canonical: null, reason: 'handler has no command to hash' };

	const normalized = {
		type: typeof handler?.type === 'string' ? handler.type : 'command',
		command,
		async: handler?.async === true,
		timeout: effectiveTimeout(event, handler?.timeout),
	};
	if (handler?.statusMessage !== undefined) normalized.statusMessage = handler.statusMessage;

	const identity = { event_name: snakeCaseEvent(event) };
	if (MATCHER_EVENT_SET.has(event) && typeof matcher === 'string') identity.matcher = matcher;
	identity.hooks = [normalized];

	const canonical = JSON.stringify(sortKeysDeep(identity));
	return {
		hash: `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
		canonical,
		reason: null,
	};
}

/**
 * Splits a hook command into whitespace-delimited tokens. Good enough for the
 * shapes Codex actually writes (`python3 '/abs/path.py'`, `[ ! -f "/abs" ] ||
 * node "/abs"`) — this is not a general shell tokenizer.
 */
function tokenize(command) {
	if (typeof command !== 'string' || command.trim().length === 0) return [];
	return command.trim().split(/\s+/);
}

/**
 * Expands the two variables a Codex hook command is known to carry, then strips
 * quote characters left over from shell word-gluing. Codex's full substitution
 * set is not documented anywhere the panel can check, so an unrecognised `$VAR`
 * is left in place and the token stops looking like a path — which is how it
 * ends up reported as `unresolved` instead of as a wrong file.
 */
function expandToken(token, { home, codexHome, projectRoot }) {
	let value = token;
	let resolvedFrom = null;

	if (/\$\{CODEX_HOME\}|\$CODEX_HOME\b/.test(value)) {
		value = value.replace(/\$\{CODEX_HOME\}|\$CODEX_HOME/g, codexHome);
		resolvedFrom = 'CODEX_HOME';
	}
	if (/\$\{CODEX_PROJECT_DIR\}|\$CODEX_PROJECT_DIR\b/.test(value)) {
		value = value.replace(/\$\{CODEX_PROJECT_DIR\}|\$CODEX_PROJECT_DIR/g, projectRoot);
		resolvedFrom = resolvedFrom ?? 'CODEX_PROJECT_DIR';
	}
	if (/\$\{HOME\}|\$HOME\b/.test(value)) {
		value = value.replace(/\$\{HOME\}|\$HOME/g, home);
		resolvedFrom = resolvedFrom ?? 'HOME';
	}
	value = value.replace(/["']/g, '');

	return { value, resolvedFrom };
}

/**
 * Resolves a hook command to the absolute script path it would run. Never
 * guesses: a command with no token that looks like a filesystem path yields
 * `scriptPath: null, resolvedFrom: 'unresolved'`.
 */
function resolveScriptPath(command, context) {
	for (const rawToken of tokenize(command)) {
		const { value, resolvedFrom } = expandToken(rawToken, context);
		if (!value.includes('/')) continue; // bare interpreter name or flag, not a path
		if (value.startsWith('/')) return { scriptPath: value, resolvedFrom: resolvedFrom ?? 'absolute' };
		return { scriptPath: null, resolvedFrom: 'unresolved' };
	}
	return { scriptPath: null, resolvedFrom: 'unresolved' };
}

/**
 * Inspects a resolved script with `fs.statSync` only. "Missing" and "present
 * but never chmod +x'd" are told apart because they are different findings.
 */
function inspectScript(scriptPath) {
	// No script token in the command (an inline `echo`, a shell pipeline, an
	// unexpanded ${VAR}): "does the script exist" has no answer, and `false`
	// would render as "script missing" -- the panel asserting a file went
	// missing when it never identified a file. `null` is the honest answer.
	if (!scriptPath) return { scriptExists: null, scriptExecutable: null, scriptError: null };
	try {
		const stat = fs.statSync(scriptPath);
		return { scriptExists: true, scriptExecutable: Boolean(stat.mode & 0o100), scriptError: null };
	} catch (error) {
		return { scriptExists: false, scriptExecutable: false, scriptError: String(error?.message || error) };
	}
}

/**
 * The main checkout behind `projectRoot`, when `projectRoot` is a linked
 * worktree. Returns null for a normal checkout, a non-repository, or any git
 * failure — a missing answer is reported as no substitution, never guessed.
 */
function mainCheckoutOf(projectRoot) {
	let commonDir;
	try {
		commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
			cwd: projectRoot,
			encoding: 'utf8',
			timeout: GIT_TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
	if (!commonDir) return null;

	const absoluteCommonDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(projectRoot, commonDir);
	if (path.basename(absoluteCommonDir) !== '.git') return null;

	const mainRoot = path.dirname(absoluteCommonDir);
	return path.resolve(mainRoot) === path.resolve(projectRoot) ? null : mainRoot;
}

/**
 * Reads every `[hooks.state."<key>"] trusted_hash` out of one config.toml.
 *
 * @returns {Map<string, {hash: string, path: string, line: number|null}>}
 */
function readTrustState(configPath) {
	const out = new Map();
	let content;
	try {
		content = fs.readFileSync(configPath, 'utf8');
	} catch {
		return out;
	}
	const { value, locations } = parseToml(content);
	const state = value?.hooks?.state;
	if (!state || typeof state !== 'object') return out;

	for (const [key, entry] of Object.entries(state)) {
		const hash = entry?.trusted_hash;
		if (typeof hash !== 'string') continue;
		out.set(key, { hash, path: configPath, line: lineOfTomlKey(locations, ['hooks', 'state', key, 'trusted_hash']) });
	}
	return out;
}

/** True when the config layer that records trust could be read at all. */
function trustStateReadable(configPath) {
	try {
		fs.accessSync(configPath, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Turns one hooks.json-shaped document into rows.
 *
 * `trustable` is false for plugin manifests: the trust key is built from the
 * path the LOADER used, and no recorded key on this machine names a plugin
 * file, so whether plugin hooks are keyed this way is unverified. Those rows
 * carry `trusted: null` and say why rather than accusing a plugin of being
 * untrusted on a rule the panel has not confirmed.
 */
function rowsFromHooksDocument({ layer, sourcePath, file, context, trust, note, trustable }) {
	const rows = [];
	const hooksByEvent = file.json?.hooks;
	if (!hooksByEvent || typeof hooksByEvent !== 'object') return rows;

	for (const [event, groups] of Object.entries(hooksByEvent)) {
		if (!Array.isArray(groups)) continue;

		groups.forEach((group, groupIndex) => {
			const matcher = typeof group?.matcher === 'string' ? group.matcher : null;
			const handlers = Array.isArray(group?.hooks) ? group.hooks : [];

			handlers.forEach((handler, hookIndex) => {
				const jsonPath = `hooks.${event}[${groupIndex}].hooks[${hookIndex}].command`;
				const line = lineOf(file.lineIndex, jsonPath);
				const command = platformCommand(handler);
				const resolved = resolveScriptPath(command, context);
				const inspected = inspectScript(resolved.scriptPath);

				const trustKey = hookTrustKey(sourcePath, event, groupIndex, hookIndex);
				const computed = computeHookTrustHash({ event, matcher, handler });
				const recorded = trustable ? (trust.entries.get(trustKey) ?? null) : null;

				let trusted = null;
				let trustNote;
				if (!trustable) {
					trustNote =
						'Plugin hook manifests are not keyed in config.toml on this machine, so whether Codex records ' +
						'their trust under this key is unverified. Trust is not claimed either way.';
				} else if (!trust.readable) {
					trustNote = `Trust state unreadable: ${trust.path} could not be opened, so no hook can be judged.`;
				} else if (computed.hash === null) {
					trusted = false;
					trustNote = `Not runnable: ${computed.reason}.`;
				} else if (!recorded) {
					trusted = false;
					trustNote =
						'No trusted_hash recorded for this hook in config.toml — Codex discovers it but will not run ' +
						'it until it is approved through /hooks.';
				} else if (recorded.hash === computed.hash) {
					trusted = true;
					trustNote = 'Recorded hash matches the declaration; Codex will run this hook.';
				} else {
					trusted = false;
					trustNote =
						'The declaration changed since it was approved: the recorded hash no longer matches. Codex ' +
						'skips this hook silently until it is re-approved through /hooks.';
				}

				const escapeHatches = [];
				if (
					GATE_SCRIPTS.some((name) => typeof resolved.scriptPath === 'string' && resolved.scriptPath.endsWith(name))
				) {
					escapeHatches.push('codex-hooks-tool-scoped');
				}
				if (trusted === false) escapeHatches.push('untrusted-hook-silently-skipped');

				rows.push({
					layer,
					event,
					eventKnown: CODEX_HOOK_EVENTS.includes(event),
					matcher,
					type: typeof handler?.type === 'string' ? handler.type : null,
					command,
					// The DECLARED timeout, null when absent, exactly like the Claude
					// module. `effectiveTimeout` is what Codex would really enforce.
					timeout: typeof handler?.timeout === 'number' ? handler.timeout : null,
					effectiveTimeout: effectiveTimeout(event, handler?.timeout),
					async: handler?.async === true,
					statusMessage: typeof handler?.statusMessage === 'string' ? handler.statusMessage : null,
					sourcePath,
					line,
					link: vscodeLink(sourcePath, line),
					groupIndex,
					hookIndex,
					scriptPath: resolved.scriptPath,
					scriptExists: inspected.scriptExists,
					scriptExecutable: inspected.scriptExecutable,
					scriptError: inspected.scriptError,
					resolvedFrom: resolved.resolvedFrom,
					escapeHatches,
					trustKey,
					trustedHash: recorded?.hash ?? null,
					trustedHashPath: recorded?.path ?? null,
					trustedHashLine: recorded?.line ?? null,
					trustedHashLink: recorded ? vscodeLink(recorded.path, recorded.line ?? 1) : null,
					expectedHash: computed.hash,
					trusted,
					trustNote,
					note,
				});
			});
		});
	}

	return rows;
}

/**
 * Plugin hook manifests inside the cache, for ENABLED plugins only.
 *
 * Three shapes exist in the wild and all three are inventoried rather than
 * guessed between: an inline `hooks` object in `.codex-plugin/plugin.json`, a
 * sibling `hooks/hooks.json`, and a `.codex/hooks.json` inside the plugin's own
 * tree. A disabled plugin contributes nothing, because Codex does not load it.
 */
function pluginHookRows({ paths, context, trust }) {
	const rows = [];
	const enabled = readEnabledPlugins(paths.user.config);
	let marketplaces;
	try {
		marketplaces = fs.readdirSync(paths.plugin.cacheDir, { withFileTypes: true });
	} catch {
		return rows;
	}

	for (const marketplace of marketplaces) {
		if (!marketplace.isDirectory()) continue;
		let plugins;
		try {
			plugins = fs.readdirSync(path.join(paths.plugin.cacheDir, marketplace.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const plugin of plugins) {
			if (!plugin.isDirectory()) continue;
			const id = `${plugin.name}@${marketplace.name}`;
			// Absent from config.toml and explicitly disabled are the same thing
			// here: Codex does not load the plugin, so it contributes no hooks.
			if (enabled.get(id) !== true) continue;

			const pluginDir = path.join(paths.plugin.cacheDir, marketplace.name, plugin.name);
			let versions;
			try {
				versions = fs.readdirSync(pluginDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const version of versions) {
				if (!version.isDirectory()) continue;
				const versionDir = path.join(pluginDir, version.name);
				for (const candidate of [
					path.join(versionDir, 'hooks', 'hooks.json'),
					path.join(versionDir, '.codex', 'hooks.json'),
				]) {
					const file = readJsonFile(candidate);
					if (!file.readable) continue;
					rows.push(
						...rowsFromHooksDocument({
							layer: 'plugin',
							sourcePath: candidate,
							file,
							context,
							trust,
							trustable: false,
							note: `Declared by plugin ${id} (${version.name}). Enabled in config.toml.`,
						}),
					);
				}

				// An inline `hooks` object in the manifest. Empty objects are the
				// common case here and contribute nothing, which is correct.
				const manifestPath = path.join(versionDir, '.codex-plugin', 'plugin.json');
				const manifest = readJsonFile(manifestPath);
				if (manifest.readable && manifest.json?.hooks && typeof manifest.json.hooks === 'object') {
					rows.push(
						...rowsFromHooksDocument({
							layer: 'plugin',
							sourcePath: manifestPath,
							file: manifest,
							context,
							trust,
							trustable: false,
							note: `Inline hooks in plugin ${id} (${version.name}) manifest.`,
						}),
					);
				}
			}
		}
	}
	return rows;
}

/** `[plugins."<plugin>@<marketplace>"] enabled` -> Map<id, boolean>. */
function readEnabledPlugins(configPath) {
	const out = new Map();
	let content;
	try {
		content = fs.readFileSync(configPath, 'utf8');
	} catch {
		return out;
	}
	const { value } = parseToml(content);
	const plugins = value?.plugins;
	if (!plugins || typeof plugins !== 'object') return out;
	for (const [id, entry] of Object.entries(plugins)) {
		if (entry && typeof entry === 'object' && 'enabled' in entry) out.set(id, entry.enabled === true);
	}
	return out;
}

/**
 * @param {{home: string, projectRoot: string, codexHome?: string}} options
 * @returns {Array<object>} one row per individual hook handler, across the user
 *   layer, the project layer (substituted from the main checkout when
 *   `projectRoot` is a linked worktree) and enabled plugins. A source that is
 *   missing or unparseable simply contributes no rows.
 */
export function scanCodexHooks({ home, projectRoot, codexHome }) {
	const paths = resolveCodexPaths({ home, projectRoot, codexHome });
	const context = { home, codexHome: paths.user.dir, projectRoot };

	// Trust lives in config.toml. The user layer is the one `/hooks` writes; a
	// project config is merged on top when it exists, so a repo that records its
	// own approvals is not invisible here.
	const trustEntries = readTrustState(paths.user.config);
	for (const [key, entry] of readTrustState(paths.project.config)) trustEntries.set(key, entry);

	// Readability gates the verdict, but it is computed PER SOURCE, not just
	// from the user config.toml. A row's trustKey could be recorded in either
	// file (both feed the same merged `entries` map above), so a row can be
	// judged as soon as at least one of them was readable -- e.g. a project
	// row whose own project config.toml is readable must not read as
	// "unreadable" merely because the user config.toml happens to be absent.
	// Only when NEITHER source could be opened does trust stay unclaimed.
	const userTrustReadable = trustStateReadable(paths.user.config);
	const projectTrustReadable = trustStateReadable(paths.project.config);
	const trust = {
		entries: trustEntries,
		readable: userTrustReadable || projectTrustReadable,
		path: paths.user.config,
	};

	const rows = [];

	const userFile = readJsonFile(paths.user.hooksJson);
	rows.push(
		...rowsFromHooksDocument({
			layer: 'user',
			sourcePath: paths.user.hooksJson,
			file: userFile,
			context,
			trust,
			trustable: true,
			note: null,
		}),
	);

	const mainRoot = mainCheckoutOf(projectRoot);
	const projectHooksPath = mainRoot ? path.join(mainRoot, '.codex', 'hooks.json') : paths.project.hooksJson;
	const projectFile = readJsonFile(projectHooksPath);
	rows.push(
		...rowsFromHooksDocument({
			layer: 'project',
			sourcePath: projectHooksPath,
			file: projectFile,
			context,
			trust,
			trustable: true,
			note: mainRoot
				? `${projectRoot} is a linked worktree; Codex substitutes the main checkout's .codex hook ` +
					`declarations, so these rows come from ${projectHooksPath} and are keyed under that path.`
				: null,
		}),
	);

	rows.push(...pluginHookRows({ paths, context, trust }));

	return rows;
}

/**
 * On-demand body view for a hook's script. `content` goes through `redactText`
 * so a secret embedded in a script never reaches the caller raw.
 *
 * The server only ever calls this with a path that appeared as `scriptPath` on
 * a row this module already returned — that inventory IS the allowlist, and it
 * is what keeps the endpoint from being walked outwards into the filesystem.
 *
 * @param {string} absPath
 * @returns {{path: string, exists: boolean, content: string|null, bytes: number|null, error: string|null}}
 */
export function readHookScript(absPath) {
	if (typeof absPath !== 'string' || absPath.length === 0) {
		return { path: absPath, exists: false, content: null, bytes: null, error: 'no path given' };
	}

	let stat;
	try {
		stat = fs.statSync(absPath);
	} catch (error) {
		return { path: absPath, exists: false, content: null, bytes: null, error: String(error?.message || error) };
	}

	if (stat.isDirectory()) {
		return { path: absPath, exists: true, content: null, bytes: null, error: 'path is a directory, not a file' };
	}

	try {
		const raw = fs.readFileSync(absPath, 'utf8');
		return {
			path: absPath,
			exists: true,
			content: redactText(raw),
			bytes: Buffer.byteLength(raw, 'utf8'),
			error: null,
		};
	} catch (error) {
		return { path: absPath, exists: true, content: null, bytes: null, error: String(error?.message || error) };
	}
}
