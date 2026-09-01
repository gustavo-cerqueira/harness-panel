/**
 * Reads the `hooks` key out of every settings layer AND out of every enabled
 * plugin's `hooks/hooks.json`, flattening both into one row per individual
 * hook — the granularity the panel renders, since a single PostToolUse matcher
 * can run several scripts back to back.
 *
 * A plugin hook is not a lesser hook: it runs in this session on the same
 * events, with the same blocking behaviour, as one written into settings.json.
 * Listing only the settings layers left running code out of an inventory that
 * claimed to be complete.
 *
 * READ ONLY, and deliberately inert: this module resolves a hook's script to
 * a real filesystem path and reports whether that file exists and is
 * executable, but it never runs a hook. Executing a hook script would break
 * the panel's core guarantee (a read-only window onto the harness), so no
 * child_process import belongs anywhere near this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, vscodeLink } from './source-file.mjs';
import { lineOf } from './json-locate.mjs';
import { resolveLayerPaths } from './layers.mjs';
import { redactText } from './mask.mjs';
import { enabledPluginRoots } from './plugins-scan.mjs';

const HOOK_SETTINGS_LAYERS = ['user', 'project', 'local'];

// Which guards have a verified hole is a finding somebody made by hand, about
// one workspace's own hooks — it was hardcoded here, which made every other
// workspace's panel claim two findings that were never checked for it. It now
// lives in that workspace's `.claude/harness-curation.json` (lib/curation.mjs).

/**
 * Splits a hook command into whitespace-delimited tokens. Good enough for the
 * shapes Claude Code actually writes (`bash "$VAR"/rest/of/path`, where the
 * quote sits directly against the following path with no space) — this is
 * not a general shell tokenizer.
 */
function tokenize(command) {
	if (typeof command !== 'string' || command.trim().length === 0) return [];
	return command.trim().split(/\s+/);
}

/**
 * Expands `$CLAUDE_PROJECT_DIR` / `${CLAUDE_PROJECT_DIR}`, `$CLAUDE_PLUGIN_ROOT`
 * and `$HOME` / `${HOME}` inside one token, then strips quote characters left
 * over from shell word-gluing (`"$VAR"/rest` -> `$VAR` expands, quotes are
 * dropped, `/rest` was never quoted to begin with).
 *
 * `pluginRoot` is null for a settings-layer hook: `$CLAUDE_PLUGIN_ROOT` is only
 * defined for a hook a plugin registered, and substituting anything for it
 * elsewhere would invent a path that does not exist.
 */
function expandToken(token, { home, projectRoot, pluginRoot = null }) {
	let value = token;
	let resolvedFrom = null;

	if (pluginRoot && /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/.test(value)) {
		value = value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/g, pluginRoot);
		resolvedFrom = 'CLAUDE_PLUGIN_ROOT';
	}
	if (/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/.test(value)) {
		value = value.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g, projectRoot);
		resolvedFrom = resolvedFrom ?? 'CLAUDE_PROJECT_DIR';
	}
	if (/\$\{HOME\}|\$HOME\b/.test(value)) {
		value = value.replace(/\$\{HOME\}|\$HOME/g, home);
		resolvedFrom = resolvedFrom ?? 'HOME';
	}
	value = value.replace(/["']/g, '');

	return { value, resolvedFrom };
}

/**
 * Resolves a hook command string to the real absolute script path it would
 * run. Never guesses: a command with no token that looks like a filesystem
 * path (an interpreter name and flags, but nothing with a `/` in it) yields
 * `scriptPath: null, resolvedFrom: 'unresolved'`.
 */
function resolveScriptPath(command, { home, projectRoot, pluginRoot = null }) {
	for (const rawToken of tokenize(command)) {
		const { value, resolvedFrom } = expandToken(rawToken, { home, projectRoot, pluginRoot });
		if (!value.includes('/')) continue; // bare interpreter name or flag, not a path
		if (value.startsWith('/')) {
			return { scriptPath: value, resolvedFrom: resolvedFrom ?? 'absolute' };
		}
		return { scriptPath: null, resolvedFrom: 'unresolved' };
	}
	return { scriptPath: null, resolvedFrom: 'unresolved' };
}

/**
 * Inspects a resolved script path with `fs.statSync` only — never opens or
 * runs it. `scriptExists: null` means no script path was identified at all;
 * `scriptExists: false` and `scriptExecutable: false` are told apart
 * from each other (a configured hook whose script vanished is a distinct,
 * real finding from one whose script exists but was never chmod +x'd).
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
 * Flattens one `hooks` manifest object into rows. Shared by the settings
 * layers and by the plugin manifests so a plugin hook is inspected — script
 * resolution, existence, exec bit, escape hatches — by exactly the same rules
 * as a settings hook, rather than a parallel implementation that could relax.
 */
function collectHookRows({
	hooksByEvent,
	file,
	sourcePath,
	layer,
	home,
	projectRoot,
	pluginRoot,
	plugin,
	pluginVersion,
}) {
	const rows = [];
	if (!hooksByEvent || typeof hooksByEvent !== 'object') return rows;

	for (const [event, blocks] of Object.entries(hooksByEvent)) {
		if (!Array.isArray(blocks)) continue;

		blocks.forEach((block, blockIndex) => {
			const matcher = typeof block?.matcher === 'string' ? block.matcher : null;
			const hookList = Array.isArray(block?.hooks) ? block.hooks : [];

			hookList.forEach((hook, hookIndex) => {
				const jsonPath = `hooks.${event}[${blockIndex}].hooks[${hookIndex}].command`;
				const line = lineOf(file.lineIndex, jsonPath);
				const command = typeof hook?.command === 'string' ? hook.command : null;
				const resolved = resolveScriptPath(command, { home, projectRoot, pluginRoot });
				const inspected = inspectScript(resolved.scriptPath);

				rows.push({
					layer,
					plugin,
					pluginVersion,
					event,
					matcher,
					type: typeof hook?.type === 'string' ? hook.type : null,
					command,
					timeout: typeof hook?.timeout === 'number' ? hook.timeout : null,
					sourcePath,
					line,
					link: vscodeLink(sourcePath, line),
					scriptPath: resolved.scriptPath,
					scriptExists: inspected.scriptExists,
					scriptExecutable: inspected.scriptExecutable,
					scriptError: inspected.scriptError,
					resolvedFrom: resolved.resolvedFrom,
				});
			});
		});
	}
	return rows;
}

/**
 * @param {{home: string, projectRoot: string}} options
 * @returns {Array<object>} one row per individual hook: the three settings
 *   layers (user, project, local) plus every hook an ENABLED plugin registers
 *   through its `hooks/hooks.json`. A plugin hook fires in this session exactly
 *   like a settings hook, so leaving it out made the section's inventory
 *   incomplete in the one direction that matters — code that runs and is not
 *   listed. Only the active cached version is read: a hook sitting in a stale
 *   version directory never fires, and listing it would be a false claim.
 *
 *   A layer or manifest whose file is missing or fails to parse simply
 *   contributes no rows — it is never faked as empty data standing in for a
 *   read that did not happen.
 */
export function scanHooks({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });
	const rows = [];

	for (const layer of HOOK_SETTINGS_LAYERS) {
		const sourcePath = paths[layer].settings;
		const file = readJsonFile(sourcePath);
		rows.push(
			...collectHookRows({
				hooksByEvent: file.json?.hooks,
				file,
				sourcePath,
				layer,
				home,
				projectRoot,
				pluginRoot: null,
				plugin: null,
				pluginVersion: null,
			}),
		);
	}

	for (const root of enabledPluginRoots({ home, projectRoot })) {
		const sourcePath = path.join(root.path, 'hooks', 'hooks.json');
		const file = readJsonFile(sourcePath);
		rows.push(
			...collectHookRows({
				hooksByEvent: file.json?.hooks,
				file,
				sourcePath,
				layer: 'plugin',
				home,
				projectRoot,
				pluginRoot: root.path,
				plugin: root.name,
				pluginVersion: root.version,
			}),
		);
	}

	return rows;
}

/**
 * On-demand body view for a hook's script. `content` is passed through
 * `redactText` so a secret embedded in a script never reaches the caller raw.
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
