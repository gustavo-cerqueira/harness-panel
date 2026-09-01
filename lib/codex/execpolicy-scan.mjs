/**
 * Codex exec policy: `~/.codex/rules/*.rules` and `<repo>/.codex/rules/*.rules`.
 *
 * Claude Code has no counterpart section for this -- it is Codex's own
 * sandbox rule language, a Starlark-like DSL of `prefix_rule(...)` calls that
 * classify a command's argument vector as allowed, prompt-worthy, or
 * forbidden before the sandbox/approval layer ever runs it. An `allow` rule
 * grants no filesystem or network capability by itself; it only decides
 * whether Codex asks before running a command that already fits inside the
 * active sandbox.
 *
 * Syntax (confirmed 2026-08-26, one real example):
 *
 *   prefix_rule(
 *       pattern=["git", ["status", "diff"]],
 *       decision="allow",
 *       justification="Read-only Git inspection",
 *       match=[["git", "status"]],
 *       not_match=[["git", "push"]],
 *   )
 *
 * `pattern` matches the command argv from the start; an element that is
 * itself an array is a union of literals ("any one of these"). This scanner
 * renders each union as a single `"a|b"` string so `pattern` is always
 * `string[]`, matching the row shape the server registry and the
 * `execpolicy` adapter in public/app.js both expect. `decision` is one of
 * `allow` / `prompt` / `forbidden`; when several rules match the same
 * command the most restrictive wins (`forbidden > prompt > allow`), but that
 * resolution happens inside Codex at run time -- this panel only inventories
 * the rules, it never simulates which one would win for a given command.
 *
 * PARSER: hand-rolled, not a full Starlark implementation. It tokenizes
 * string literals (single/double-quoted, backslash escapes), `[`/`]`
 * arrays (including nested unions), and `prefix_rule(...)` calls that may
 * span multiple physical lines -- the real file is one call per line, but
 * the grammar allows more and the parser does not assume the shorter form.
 * `#` starts a line comment everywhere outside a string. Anything that is
 * not blank, not a comment, and not part of a `prefix_rule(...)` call it
 * could parse becomes its own row: `decision: 'unknown'`, `note: 'unparsed'`,
 * `raw` capped to 200 chars -- never silently dropped.
 *
 * Every string this module emits (pattern elements, decision, justification,
 * match/notMatch entries, the unparsed `raw` line) goes through `redactText`
 * before it leaves the module: a `prefix_rule` command line is free-form
 * shell text, and shell text is exactly where a stray secret hides.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, vscodeLink } from '../source-file.mjs';
import { redactText } from '../mask.mjs';
import { resolveCodexPaths } from './layers.mjs';

const RAW_CAP = 200;

function listRuleFiles(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.rules'))
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

/** Strips a `#...` line comment, ignoring `#` characters inside a string literal on that same line. */
function stripLineComment(line) {
	let inQuote = null;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (inQuote) {
			if (ch === '\\') {
				i += 1;
				continue;
			}
			if (ch === inQuote) inQuote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inQuote = ch;
			continue;
		}
		if (ch === '#') return line.slice(0, i);
	}
	return line;
}

function countNewlines(text, upToIndex) {
	let count = 0;
	for (let i = 0; i < upToIndex; i += 1) if (text[i] === '\n') count += 1;
	return count;
}

/** Index of the `)` that closes the `(` at `openIdx`, respecting quotes. -1 if never closed. */
function findMatchingParen(text, openIdx) {
	let depth = 0;
	let inQuote = null;
	for (let i = openIdx; i < text.length; i += 1) {
		const ch = text[i];
		if (inQuote) {
			if (ch === '\\') {
				i += 1;
				continue;
			}
			if (ch === inQuote) inQuote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inQuote = ch;
			continue;
		}
		if (ch === '(') depth += 1;
		else if (ch === ')') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };

function tokenize(text) {
	const tokens = [];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i];
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			i += 1;
			continue;
		}
		if ('()[],='.includes(ch)) {
			tokens.push({ t: ch });
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let j = i + 1;
			let value = '';
			while (j < n && text[j] !== quote) {
				if (text[j] === '\\' && j + 1 < n) {
					const next = text[j + 1];
					value += ESCAPES[next] !== undefined ? ESCAPES[next] : next;
					j += 2;
					continue;
				}
				value += text[j];
				j += 1;
			}
			tokens.push({ t: 'STRING', v: value });
			i = j + 1;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			let j = i;
			while (j < n && /[A-Za-z0-9_]/.test(text[j])) j += 1;
			tokens.push({ t: 'IDENT', v: text.slice(i, j) });
			i = j;
			continue;
		}
		i += 1; // unknown character -- skip defensively rather than throw
	}
	return tokens;
}

/** Parses one value at `pos`: a string, or a `[...]` array (possibly nested). */
function parseValue(tokens, pos) {
	const tok = tokens[pos];
	if (!tok) return { value: null, pos };
	if (tok.t === 'STRING') return { value: tok.v, pos: pos + 1 };
	if (tok.t === '[') {
		const items = [];
		let p = pos + 1;
		while (tokens[p] && tokens[p].t !== ']') {
			const parsed = parseValue(tokens, p);
			items.push(parsed.value);
			p = parsed.pos;
			if (tokens[p] && tokens[p].t === ',') p += 1;
		}
		if (tokens[p] && tokens[p].t === ']') p += 1;
		return { value: items, pos: p };
	}
	return { value: null, pos: pos + 1 };
}

/** Parses `prefix_rule(key=value, ...)` into `{ key: value }`. Returns null when the head does not match. */
function parseCall(tokens) {
	let p = 0;
	if (!tokens[p] || tokens[p].t !== 'IDENT' || tokens[p].v !== 'prefix_rule') return null;
	p += 1;
	if (!tokens[p] || tokens[p].t !== '(') return null;
	p += 1;

	const args = {};
	while (tokens[p] && tokens[p].t !== ')') {
		if (tokens[p].t !== 'IDENT') {
			p += 1;
			continue;
		}
		const key = tokens[p].v;
		p += 1;
		if (tokens[p] && tokens[p].t === '=') p += 1;
		const parsed = parseValue(tokens, p);
		args[key] = parsed.value;
		p = parsed.pos;
		if (tokens[p] && tokens[p].t === ',') p += 1;
	}
	return args;
}

/** Renders a raw `pattern` array (strings and/or union sub-arrays) as `string[]`, unions joined "a|b". */
function renderPattern(raw) {
	if (!Array.isArray(raw)) return [];
	return raw.map((item) =>
		redactText(Array.isArray(item) ? item.map((s) => String(s ?? '')).join('|') : String(item ?? '')),
	);
}

/** Renders `match`/`not_match`: an array of argv-prefix arrays, or null when absent/malformed. */
function renderNestedStrings(raw) {
	if (!Array.isArray(raw)) return null;
	return raw.map((entry) =>
		Array.isArray(entry) ? entry.map((s) => redactText(String(s ?? ''))) : redactText(String(entry ?? '')),
	);
}

function unparsedRow({ filePath, layer, line, raw }) {
	return {
		pattern: [],
		decision: 'unknown',
		justification: null,
		match: null,
		notMatch: null,
		path: filePath,
		line,
		link: vscodeLink(filePath, line),
		layer,
		note: 'unparsed',
		raw: redactText(String(raw ?? '').slice(0, RAW_CAP)),
	};
}

function buildRuleRow({ args, startLine, filePath, layer }) {
	return {
		pattern: renderPattern(args.pattern),
		decision: typeof args.decision === 'string' ? redactText(args.decision) : 'unknown',
		justification: typeof args.justification === 'string' ? redactText(args.justification) : null,
		match: renderNestedStrings(args.match),
		notMatch: renderNestedStrings(args.not_match),
		path: filePath,
		line: startLine,
		link: vscodeLink(filePath, startLine),
		layer,
		note: null,
		raw: null,
	};
}

function parseRulesFile(rawContent, filePath, layer) {
	const lines = rawContent.split('\n');
	const cleanLines = lines.map(stripLineComment);
	const cleanText = cleanLines.join('\n');
	const consumed = new Array(lines.length).fill(false);
	const rows = [];

	const callRe = /prefix_rule\s*\(/g;
	let match;
	while ((match = callRe.exec(cleanText))) {
		const openParenIdx = match.index + match[0].length - 1;
		const startLine = countNewlines(cleanText, match.index) + 1;
		const endIdx = findMatchingParen(cleanText, openParenIdx);

		if (endIdx === -1) {
			consumed[startLine - 1] = true;
			rows.push(unparsedRow({ filePath, layer, line: startLine, raw: lines[startLine - 1] }));
			break; // no closing paren anywhere in the rest of the file -- nothing left to scan
		}

		const endLine = countNewlines(cleanText, endIdx) + 1;
		for (let l = startLine; l <= endLine; l += 1) consumed[l - 1] = true;

		const statementText = cleanText.slice(match.index, endIdx + 1);
		const args = parseCall(tokenize(statementText));
		if (!args || !Array.isArray(args.pattern) || typeof args.decision !== 'string') {
			rows.push(unparsedRow({ filePath, layer, line: startLine, raw: lines[startLine - 1] }));
		} else {
			rows.push(buildRuleRow({ args, startLine, filePath, layer }));
		}
		callRe.lastIndex = endIdx + 1;
	}

	for (let i = 0; i < lines.length; i += 1) {
		if (consumed[i]) continue;
		if (cleanLines[i].trim().length === 0) continue; // blank or comment-only line
		rows.push(unparsedRow({ filePath, layer, line: i + 1, raw: lines[i] }));
	}

	rows.sort((a, b) => a.line - b.line);
	return rows;
}

export function scanExecPolicy({ home, projectRoot }) {
	try {
		const paths = resolveCodexPaths({ home, projectRoot });
		const sources = [
			{ dir: paths.user.rulesDir, layer: 'user' },
			{ dir: path.join(paths.project.codexDir, 'rules'), layer: 'project' },
		];

		const rules = [];
		const files = [];
		for (const { dir, layer } of sources) {
			for (const filePath of listRuleFiles(dir)) {
				const file = readSourceFile(filePath);
				files.push({ path: filePath, exists: file.exists, bytes: file.size, error: file.error, layer });
				if (!file.readable || file.content == null) continue;
				rules.push(...parseRulesFile(file.content, filePath, layer));
			}
		}

		return { rules, files, error: null };
	} catch (error) {
		return { rules: [], files: [], error: String(error?.message || error) };
	}
}
