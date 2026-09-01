/**
 * Codex custom prompts and the built-in slash-command registry.
 *
 * Codex counterpart of `../commands-scan.mjs`. Same top-level shape
 * (`{ commands, notes }`) and the same per-row field names, so
 * public/app.js renders both through the same `commands` adapter, keyed by
 * section id `commands` even though the CODEX_SECTIONS label calls it
 * "Custom prompts" -- Codex's own vocabulary for the concept.
 *
 * THREE kinds of row, all in the same `commands` array:
 *
 *   1. Custom prompts -- `~/.codex/prompts/*.md`, TOP-LEVEL FILES ONLY (no
 *      project layer, no subdirectory namespacing; confirmed: only
 *      top-level Markdown files are discovered, and a session reload is
 *      needed after edits). Invoked as `/prompts:<stem>`, so `name` carries
 *      that `prompts:` prefix already -- the adapter prepends `/`, same as
 *      Claude's `opsx:apply`-style namespaced commands.
 *   2. The built-in static registry (layer 'builtin', `path: null`) -- not
 *      read from disk, because Codex's built-ins are compiled into the CLI
 *      binary. This is the exact 0.149.1 tagged registry as Codex reported
 *      it, not a guess.
 *   3. Aliases (`/cwd`, `/pet`, `/clean`) as their own rows, flagged
 *      `aliasOf` instead of duplicating the target's row.
 *
 * `invocations` is always null (never a guessed 0): rollouts carry no
 * distinguishable custom-prompt provenance -- a `/prompts:x` expansion
 * becomes an ordinary user message with no record of which prompt produced
 * it, so reliable usage counting from session history alone is unverified.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, vscodeLink } from '../source-file.mjs';
import { resolveCodexPaths } from './layers.mjs';

/** Exact 0.149.1 tagged static registry (codex-rs/tui/src/slash_command.rs), leading `/` stripped. */
const BUILTIN_COMMANDS = [
	'model',
	'ide',
	'permissions',
	'keymap',
	'vim',
	'setup-default-sandbox',
	'experimental',
	'approve',
	'memories',
	'skills',
	'import',
	'hooks',
	'review',
	'rename',
	'new',
	'archive',
	'delete',
	'resume',
	'fork',
	'app',
	'init',
	'compact',
	'plan',
	'goal',
	'agents',
	'side',
	'btw',
	'copy',
	'export',
	'raw',
	'diff',
	'mention',
	'status',
	'cd',
	'pwd',
	'usage',
	'debug-config',
	'title',
	'statusline',
	'theme',
	'pets',
	'mcp',
	'apps',
	'plugins',
	'logout',
	'quit',
	'exit',
	'feedback',
	'ps',
	'stop',
	'clear',
	'personality',
	'subagents',
	'debug-m-drop',
	'debug-m-update',
];

/** `alias -> target`, both without the leading `/`. */
const BUILTIN_ALIASES = { cwd: 'pwd', pet: 'pets', clean: 'stop' };

function unquote(value) {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Splits the leading `---` frontmatter fence from the body, reading only
 * `description` and `argument-hint` (the two keys Codex's custom-prompts
 * guide documents). A missing/unterminated fence yields an empty meta object
 * and the whole file as body -- never an error, since most prompt files are
 * plain instructions with no frontmatter at all.
 */
function splitFrontmatter(content) {
	const meta = { description: null, argumentHint: null };
	if (typeof content !== 'string') return { meta, body: '' };

	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return { meta, body: content };

	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trim() === '---') {
			end = i;
			break;
		}
	}
	if (end === -1) return { meta, body: content };

	for (let i = 1; i < end; i += 1) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
		if (!match) continue;
		const key = match[1];
		const value = unquote(match[2].trim());
		if (key === 'description') meta.description = value.length > 0 ? value : null;
		else if (key === 'argument-hint') meta.argumentHint = value.length > 0 ? value : null;
	}
	return { meta, body: lines.slice(end + 1).join('\n') };
}

/**
 * Template placeholders documented by Codex's custom-prompts guide:
 * `$1`..`$9`, `$ARGUMENTS`, and named uppercase placeholders (`$FILE`,
 * supplied as `FILE=value`). `$$` is the literal-dollar escape, not a
 * placeholder, so it is matched (to avoid misreading it as two tokens) and
 * then discarded. Returns a deduped, sorted list -- which token appears,
 * not how many times.
 */
function findPlaceholders(body) {
	if (typeof body !== 'string' || body.length === 0) return [];
	const found = new Set();
	const re = /\$(?:[1-9]|ARGUMENTS|[A-Z][A-Z0-9_]*|\$)/g;
	let match;
	while ((match = re.exec(body))) {
		if (match[0] === '$$') continue;
		found.add(match[0]);
	}
	return [...found].sort();
}

function listTopLevelPromptFiles(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

function buildPromptRow(absPath) {
	const file = readSourceFile(absPath);
	const stem = path.basename(absPath).replace(/\.md$/, '');
	const name = `prompts:${stem}`;
	const { meta, body } =
		file.readable && file.content != null
			? splitFrontmatter(file.content)
			: { meta: { description: null, argumentHint: null }, body: '' };

	return {
		name,
		layer: 'user',
		path: absPath,
		line: 1,
		link: vscodeLink(absPath, 1),
		description: meta.description,
		allowedTools: null,
		disableModelInvocation: false,
		argumentHint: meta.argumentHint,
		invocations: null,
		aliasOf: null,
		placeholders: findPlaceholders(body),
		bytes: file.size,
		error: file.error,
	};
}

function buildBuiltinRow(name) {
	return {
		name,
		layer: 'builtin',
		path: null,
		line: 1,
		link: null,
		description: null,
		allowedTools: null,
		disableModelInvocation: false,
		argumentHint: null,
		invocations: null,
		aliasOf: null,
		placeholders: [],
		bytes: null,
		error: null,
	};
}

function buildAliasRow(name, targetName) {
	return { ...buildBuiltinRow(name), aliasOf: targetName };
}

export function scanCodexPrompts({ home, projectRoot }) {
	const paths = resolveCodexPaths({ home, projectRoot });

	const commands = listTopLevelPromptFiles(paths.user.promptsDir).map(buildPromptRow);
	for (const name of BUILTIN_COMMANDS) commands.push(buildBuiltinRow(name));
	for (const [alias, target] of Object.entries(BUILTIN_ALIASES)) commands.push(buildAliasRow(alias, target));

	const notes = [
		'The built-in command list is the 0.149.1 static registry as Codex itself reported it (codex-rs/tui/src/slash_command.rs), not read from any file on disk.',
		'Rollouts carry no custom-prompt invocation provenance -- a /prompts:<name> expansion becomes an ordinary user message with nothing tying it back to the prompt file -- so invocations is null, never a guessed 0.',
		'Excluded from the built-in list: /sandbox-add-read-dir (Windows only), /rollout and /test-approval (debug builds only), and dynamic service-tier commands like /fast, none of which this panel can confirm are active on this install.',
	];

	return { commands, notes };
}
