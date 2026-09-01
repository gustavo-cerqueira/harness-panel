/**
 * TOML line-tracking scanner for Codex CLI configuration files.
 *
 * Codex counterpart of `../json-locate.mjs`: that module maps every key in a
 * JSON settings file to the 1-based line it is defined on so the panel can
 * deep-link a row to `vscode://file/<abs-path>:<line>`. Codex's own config
 * (`~/.codex/config.toml`, `~/.codex/agents/*.toml`, `<repo>/.codex/agents/*.toml`,
 * profile files) is TOML, not JSON, so it needs its own scanner — but the same
 * deep-link guarantee: every value the panel renders must resolve back to the
 * exact line its key was written on, in the raw source text.
 *
 * `parseToml(text)` is a hand-written, tolerant recursive-descent parser (not
 * a validating one). It returns `{ value, locations, errors }`:
 *   - `value` is a plain JS object tree, the same shape `JSON.parse` would
 *     hand back for the equivalent structure.
 *   - `locations` is a `Map<string, {line, column}>` keyed by
 *     `JSON.stringify(pathArray)`, where `pathArray` segments are exactly as
 *     written: a quoted key (`"/Users/x/y"` or a bare `a.b`) is decoded and
 *     kept as ONE array entry; a dotted bare key (`a.b`) becomes TWO entries;
 *     an array-of-tables row gets a numeric index entry (as a string), e.g.
 *     `["servers", "0", "name"]`. Table headers (`[a.b]`, `[[a.b]]`) also get
 *     an entry under their OWN path, so a row that deep-links to a whole
 *     table (not just one of its keys) still resolves to a real line.
 *   - `errors` is `[{ line, message }]`.
 *
 * BEST-EFFORT, LIKE `json-locate.mjs`: this never throws on bad input. Any
 * statement (a `key = value` line or a `[table]` / `[[table]]` header) that
 * fails to parse is recorded as one error at the line it started on, and the
 * scanner recovers by skipping to the next line and continuing — a broken
 * `config.toml` still yields every key it MANAGED to read, because a broken
 * config is exactly when a jump-to-source link matters most. A key defined
 * twice at the same path is also recorded as an error, keeping the FIRST
 * value (later ones are discarded, mirroring real TOML's "duplicate keys are
 * an error" rule without aborting the whole scan).
 *
 * `lineOfTomlKey(locations, pathArray)` is a direct lookup (line or null) —
 * unlike `json-locate.mjs`'s `lineOf`, it does NOT degrade to the nearest
 * known ancestor, because a TOML path is always resolved from the already-
 * parsed `value` tree (which never asks for a path that doesn't exist).
 *
 * `flattenToml(value)` walks a parsed `value` tree and returns one entry per
 * LEAF (scalars and arrays of scalars; plain tables recurse; arrays whose
 * elements are all plain objects — i.e. array-of-tables shape — recurse with
 * numeric index segments). Each entry is `{ path, key, value }`, where `key`
 * is the dotted, TOML-quoted rendering of `path` (a segment containing '.',
 * '/', a space, or a quote character is rendered `"quoted"`).
 *
 * Deliberately unsupported (documented, not silently wrong):
 *   - Multi-line inline tables. TOML conventionally treats `{ ... }` as
 *     single-line only, and the panel only ever needs to render single-line
 *     ones (`{ a = 1, b = "x" }`), so a raw newline inside `{ }` is an error.
 *   - Per-key line locations for keys NESTED inside an inline table — only
 *     the top-level key that HOLDS the inline table gets a location. The
 *     interior is reachable via `value`, just not individually deep-linkable.
 *   - Space-separated datetimes (`1979-05-27 07:32:00`, no `T`). A bare space
 *     is a token delimiter everywhere else, so only `T`/`t`-joined datetimes,
 *     bare dates, and bare times are recognized as one atomic token; a
 *     space-joined datetime typed unquoted (rare in real Codex configs) is
 *     read as two separate broken tokens and reported as an error.
 *   - Full TOML 1.0 validation (leading-zero integers, strict table/key
 *     redefinition rules, `[[a.b]]` under `[a]` sequencing, etc.). Re-opening
 *     a `[table]` whose path was already auto-vivified as an implicit parent
 *     is silently reused rather than flagged — this is a location-tracking
 *     scanner, not a spec-compliance checker, exactly like `json-locate.mjs`.
 *   - `__proto__` / `constructor` / `prototype` as a key or table segment is
 *     refused (recorded as an error, value discarded) rather than mutating
 *     the object prototype — defensive, since this module ends up parsing
 *     files that are not always hand-authored by the reader.
 */

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

class TomlParseError extends Error {
	constructor(message, line) {
		super(message);
		this.line = line;
	}
}

// ---------------------------------------------------------------------------
// Cursor primitives
// ---------------------------------------------------------------------------

function makeCursor(text) {
	return { text, i: 0, line: 1, lineStart: 0 };
}

function eof(st) {
	return st.i >= st.text.length;
}

function peek(st) {
	return st.text[st.i];
}

function peekAt(st, offset) {
	return st.text[st.i + offset];
}

function colOf(st) {
	return st.i - st.lineStart + 1;
}

function advance(st) {
	if (st.text[st.i] === '\n') {
		st.line += 1;
		st.lineStart = st.i + 1;
	}
	st.i += 1;
}

function skipInlineWs(st) {
	while (!eof(st) && (peek(st) === ' ' || peek(st) === '\t')) advance(st);
}

/** Whitespace, blank lines, and `#` comments — used between statements and inside arrays. */
function skipWsCommentsAndNewlines(st) {
	while (!eof(st)) {
		const ch = peek(st);
		if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
			advance(st);
			continue;
		}
		if (ch === '#') {
			while (!eof(st) && peek(st) !== '\n') advance(st);
			continue;
		}
		break;
	}
}

function skipTrailingCommentToNewline(st) {
	skipInlineWs(st);
	if (!eof(st) && peek(st) === '#') {
		while (!eof(st) && peek(st) !== '\n') advance(st);
	}
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

function readHexDigits(st, count, startLine) {
	let out = '';
	for (let n = 0; n < count; n += 1) {
		if (eof(st) || !/[0-9A-Fa-f]/.test(peek(st))) throw new TomlParseError('invalid unicode escape', startLine);
		out += peek(st);
		advance(st);
	}
	return out;
}

/** Assumes `st` is positioned AT the backslash. Consumes the whole escape sequence. */
function readEscape(st, startLine) {
	advance(st); // consume '\'
	if (eof(st)) throw new TomlParseError('unterminated escape sequence', startLine);
	const ch = peek(st);
	const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' };
	if (Object.hasOwn(simple, ch)) {
		advance(st);
		return simple[ch];
	}
	if (ch === 'u') {
		advance(st);
		return String.fromCodePoint(Number.parseInt(readHexDigits(st, 4, startLine), 16));
	}
	if (ch === 'U') {
		advance(st);
		return String.fromCodePoint(Number.parseInt(readHexDigits(st, 8, startLine), 16));
	}
	throw new TomlParseError(`invalid escape sequence: \\${ch}`, startLine);
}

function readBasicStringSingleLine(st) {
	const startLine = st.line;
	advance(st); // opening '"'
	let out = '';
	while (true) {
		if (eof(st)) throw new TomlParseError('unterminated string', startLine);
		const ch = peek(st);
		if (ch === '"') {
			advance(st);
			return out;
		}
		if (ch === '\n') throw new TomlParseError('unterminated string', startLine);
		if (ch === '\\') {
			out += readEscape(st, startLine);
			continue;
		}
		out += ch;
		advance(st);
	}
}

function readLiteralStringSingleLine(st) {
	const startLine = st.line;
	advance(st); // opening "'"
	let out = '';
	while (true) {
		if (eof(st)) throw new TomlParseError('unterminated string', startLine);
		const ch = peek(st);
		if (ch === "'") {
			advance(st);
			return out;
		}
		if (ch === '\n') throw new TomlParseError('unterminated string', startLine);
		out += ch;
		advance(st);
	}
}

function trimFirstNewline(st) {
	if (peek(st) === '\r' && peekAt(st, 1) === '\n') {
		advance(st);
		advance(st);
	} else if (peek(st) === '\n') {
		advance(st);
	}
}

function readMultilineBasicString(st) {
	const startLine = st.line;
	advance(st);
	advance(st);
	advance(st); // opening '"""'
	trimFirstNewline(st);
	let out = '';
	while (true) {
		if (eof(st)) throw new TomlParseError('unterminated multi-line string', startLine);
		if (peek(st) === '"' && peekAt(st, 1) === '"' && peekAt(st, 2) === '"') {
			advance(st);
			advance(st);
			advance(st);
			return out;
		}
		if (peek(st) === '\\') {
			const save = { i: st.i, line: st.line, lineStart: st.lineStart };
			advance(st); // tentatively consume '\'
			let j = st.i;
			while (j < st.text.length && (st.text[j] === ' ' || st.text[j] === '\t' || st.text[j] === '\r')) j += 1;
			if (st.text[j] === '\n') {
				// Line-ending backslash: swallow it and all whitespace/newlines up to the next content.
				while (!eof(st) && /[ \t\r\n]/.test(peek(st))) advance(st);
				continue;
			}
			st.i = save.i;
			st.line = save.line;
			st.lineStart = save.lineStart;
			out += readEscape(st, startLine);
			continue;
		}
		out += peek(st);
		advance(st);
	}
}

function readMultilineLiteralString(st) {
	const startLine = st.line;
	advance(st);
	advance(st);
	advance(st); // opening "'''"
	trimFirstNewline(st);
	let out = '';
	while (true) {
		if (eof(st)) throw new TomlParseError('unterminated multi-line literal string', startLine);
		if (peek(st) === "'" && peekAt(st, 1) === "'" && peekAt(st, 2) === "'") {
			advance(st);
			advance(st);
			advance(st);
			return out;
		}
		out += peek(st);
		advance(st);
	}
}

// ---------------------------------------------------------------------------
// Atomic (unquoted) values: bool, int, float, inf/nan, datetime/date/time
// ---------------------------------------------------------------------------

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}([Tt]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})?)?$/;
const LOCAL_TIME_RE = /^\d{2}:\d{2}:\d{2}(\.\d+)?$/;

function parseAtomicToken(token) {
	if (token === 'true') return { ok: true, value: true };
	if (token === 'false') return { ok: true, value: false };
	if (/^[+-]?nan$/.test(token)) return { ok: true, value: NaN };
	if (/^[+-]?inf$/.test(token)) return { ok: true, value: token.startsWith('-') ? -Infinity : Infinity };
	if (DATETIME_RE.test(token) || LOCAL_TIME_RE.test(token)) return { ok: true, value: token };

	let m = /^([+-]?)0x([0-9A-Fa-f_]+)$/.exec(token);
	if (m) return { ok: true, value: (m[1] === '-' ? -1 : 1) * Number.parseInt(m[2].replace(/_/g, ''), 16) };

	m = /^([+-]?)0o([0-7_]+)$/.exec(token);
	if (m) return { ok: true, value: (m[1] === '-' ? -1 : 1) * Number.parseInt(m[2].replace(/_/g, ''), 8) };

	m = /^([+-]?)0b([01_]+)$/.exec(token);
	if (m) return { ok: true, value: (m[1] === '-' ? -1 : 1) * Number.parseInt(m[2].replace(/_/g, ''), 2) };

	if (/^[+-]?\d[\d_]*$/.test(token)) return { ok: true, value: Number(token.replace(/_/g, '')) };

	if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?$/.test(token) && /[.eE]/.test(token)) {
		return { ok: true, value: Number(token.replace(/_/g, '')) };
	}

	return { ok: false };
}

function readAtomicValue(st) {
	const line = st.line;
	let token = '';
	while (!eof(st)) {
		const ch = peek(st);
		if (
			ch === '\n' ||
			ch === '\r' ||
			ch === ' ' ||
			ch === '\t' ||
			ch === ',' ||
			ch === ']' ||
			ch === '}' ||
			ch === '#'
		) {
			break;
		}
		token += ch;
		advance(st);
	}
	if (token.length === 0) throw new TomlParseError('expected a value', line);
	const parsed = parseAtomicToken(token);
	if (!parsed.ok) throw new TomlParseError(`invalid value: ${token}`, line);
	return parsed.value;
}

// ---------------------------------------------------------------------------
// Composite values: arrays, inline tables
// ---------------------------------------------------------------------------

function parseArray(st) {
	const startLine = st.line;
	advance(st); // '['
	const arr = [];
	while (true) {
		skipWsCommentsAndNewlines(st);
		if (eof(st)) throw new TomlParseError('unterminated array', startLine);
		if (peek(st) === ']') {
			advance(st);
			return arr;
		}
		arr.push(parseValue(st));
		skipWsCommentsAndNewlines(st);
		if (eof(st)) throw new TomlParseError('unterminated array', startLine);
		const ch = peek(st);
		if (ch === ',') {
			advance(st);
			continue;
		}
		if (ch === ']') {
			advance(st);
			return arr;
		}
		throw new TomlParseError('expected , or ] in array', st.line);
	}
}

function parseInlineTable(st) {
	const startLine = st.line;
	advance(st); // '{'
	const obj = {};
	skipInlineWs(st);
	if (!eof(st) && peek(st) === '}') {
		advance(st);
		return obj;
	}
	while (true) {
		skipInlineWs(st);
		if (eof(st) || peek(st) === '\n') throw new TomlParseError('inline table must be a single line', startLine);
		const keySegs = parseKeyPath(st);
		skipInlineWs(st);
		if (eof(st) || peek(st) !== '=') throw new TomlParseError('expected = in inline table', st.line);
		advance(st);
		skipInlineWs(st);
		const val = parseValue(st);
		if (!setValueOnTable(obj, keySegs, val)) {
			throw new TomlParseError(`duplicate or conflicting key in inline table: ${keySegs.join('.')}`, st.line);
		}
		skipInlineWs(st);
		if (eof(st) || peek(st) === '\n') throw new TomlParseError('inline table must be a single line', startLine);
		const ch = peek(st);
		if (ch === ',') {
			advance(st);
			continue;
		}
		if (ch === '}') {
			advance(st);
			return obj;
		}
		throw new TomlParseError('expected , or } in inline table', st.line);
	}
}

function parseValue(st) {
	if (eof(st)) throw new TomlParseError('expected a value', st.line);
	const ch = peek(st);
	if (ch === '"') {
		if (peekAt(st, 1) === '"' && peekAt(st, 2) === '"') return readMultilineBasicString(st);
		return readBasicStringSingleLine(st);
	}
	if (ch === "'") {
		if (peekAt(st, 1) === "'" && peekAt(st, 2) === "'") return readMultilineLiteralString(st);
		return readLiteralStringSingleLine(st);
	}
	if (ch === '[') return parseArray(st);
	if (ch === '{') return parseInlineTable(st);
	return readAtomicValue(st);
}

// ---------------------------------------------------------------------------
// Keys and table navigation
// ---------------------------------------------------------------------------

function readBareKey(st) {
	let out = '';
	while (!eof(st) && BARE_KEY_CHAR.test(peek(st))) {
		out += peek(st);
		advance(st);
	}
	return out;
}

/** Parses a (possibly dotted, possibly quoted-segment) key path. Used for both
 * `key = value` statements and `[table.path]` / `[[table.path]]` headers. */
function parseKeyPath(st) {
	const segments = [];
	while (true) {
		skipInlineWs(st);
		if (eof(st)) throw new TomlParseError('unexpected end of input while reading a key', st.line);
		const ch = peek(st);
		if (ch === '"') {
			segments.push(readBasicStringSingleLine(st));
		} else if (ch === "'") {
			segments.push(readLiteralStringSingleLine(st));
		} else if (BARE_KEY_CHAR.test(ch)) {
			segments.push(readBareKey(st));
		} else {
			throw new TomlParseError(`unexpected character in key: ${JSON.stringify(ch)}`, st.line);
		}
		skipInlineWs(st);
		if (!eof(st) && peek(st) === '.') {
			advance(st);
			continue;
		}
		return segments;
	}
}

function isUnsafeSegment(seg) {
	return UNSAFE_SEGMENTS.has(seg);
}

/** Walks `segs` from `root`, auto-vivifying plain objects. Returns the final
 * table object, or null if a segment collides with a non-table value or is unsafe. */
function navigateCreateTable(root, segs) {
	let obj = root;
	for (const seg of segs) {
		if (isUnsafeSegment(seg)) return null;
		if (!Object.hasOwn(obj, seg)) {
			obj[seg] = {};
		} else if (typeof obj[seg] !== 'object' || obj[seg] === null || Array.isArray(obj[seg])) {
			return null;
		}
		obj = obj[seg];
	}
	return obj;
}

/** Sets `root.<keySegs> = val`, auto-vivifying intermediate objects for a
 * dotted key. Returns false (without mutating) on a conflict or duplicate. */
function setValueOnTable(root, keySegs, val) {
	let obj = root;
	for (let idx = 0; idx < keySegs.length - 1; idx += 1) {
		const seg = keySegs[idx];
		if (isUnsafeSegment(seg)) return false;
		if (!Object.hasOwn(obj, seg)) {
			obj[seg] = {};
		} else if (typeof obj[seg] !== 'object' || obj[seg] === null || Array.isArray(obj[seg])) {
			return false;
		}
		obj = obj[seg];
	}
	const lastKey = keySegs[keySegs.length - 1];
	if (isUnsafeSegment(lastKey) || Object.hasOwn(obj, lastKey)) return false;
	obj[lastKey] = val;
	return true;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function parseKeyValueStatement(st, currentTable, currentPath, locations, errors) {
	const keyLine = st.line;
	const keyCol = colOf(st);
	const keySegs = parseKeyPath(st);
	skipInlineWs(st);
	if (eof(st) || peek(st) !== '=') throw new TomlParseError("expected '=' after key", keyLine);
	advance(st);
	skipInlineWs(st);
	const val = parseValue(st);
	skipTrailingCommentToNewline(st);
	if (!eof(st) && peek(st) !== '\n') throw new TomlParseError('unexpected content after value', st.line);

	const fullPath = currentPath.concat(keySegs);
	const fullKey = JSON.stringify(fullPath);
	if (locations.has(fullKey)) {
		errors.push({ line: keyLine, message: `duplicate key: ${fullPath.join('.')}` });
		return;
	}
	if (!setValueOnTable(currentTable, keySegs, val)) {
		errors.push({ line: keyLine, message: `cannot set key: ${fullPath.join('.')}` });
		return;
	}
	locations.set(fullKey, { line: keyLine, column: keyCol });
}

function parseTableHeaderStatement(st, root, locations) {
	const startLine = st.line;
	const startCol = colOf(st);
	advance(st); // '['
	const isArrayTable = peek(st) === '[';
	if (isArrayTable) advance(st);
	const segs = parseKeyPath(st);
	if (eof(st) || peek(st) !== ']') throw new TomlParseError('expected ] to close table header', st.line);
	advance(st);
	if (isArrayTable) {
		if (eof(st) || peek(st) !== ']') throw new TomlParseError('expected ]] to close array-of-tables header', st.line);
		advance(st);
	}
	skipTrailingCommentToNewline(st);
	if (!eof(st) && peek(st) !== '\n') throw new TomlParseError('unexpected content after table header', st.line);

	if (isArrayTable) {
		const parentSegs = segs.slice(0, -1);
		const lastSeg = segs[segs.length - 1];
		const parentObj = navigateCreateTable(root, parentSegs);
		if (parentObj === null || isUnsafeSegment(lastSeg)) {
			throw new TomlParseError(`cannot open table [[${segs.join('.')}]]`, startLine);
		}
		if (!Object.hasOwn(parentObj, lastSeg)) {
			parentObj[lastSeg] = [];
		} else if (!Array.isArray(parentObj[lastSeg])) {
			throw new TomlParseError(`cannot redefine ${segs.join('.')} as an array of tables`, startLine);
		}
		const arr = parentObj[lastSeg];
		const newIndex = arr.length;
		const rowObj = {};
		arr.push(rowObj);
		const fullPath = [...parentSegs, lastSeg, String(newIndex)];
		locations.set(JSON.stringify(fullPath), { line: startLine, column: startCol });
		return { table: rowObj, path: fullPath };
	}

	const tbl = navigateCreateTable(root, segs);
	if (tbl === null) throw new TomlParseError(`cannot open table [${segs.join('.')}]`, startLine);
	locations.set(JSON.stringify(segs), { line: startLine, column: startCol });
	return { table: tbl, path: segs.slice() };
}

function recoverToNextLine(st) {
	while (!eof(st) && peek(st) !== '\n') advance(st);
	if (!eof(st)) advance(st);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} text raw TOML file contents
 * @returns {{value: object, locations: Map<string, {line: number, column: number}>, errors: Array<{line: number, message: string}>}}
 */
export function parseToml(text) {
	const value = {};
	const locations = new Map();
	const errors = [];
	if (typeof text !== 'string' || text.length === 0) return { value, locations, errors };

	const st = makeCursor(text);
	let currentTable = value;
	let currentPath = [];

	while (true) {
		skipWsCommentsAndNewlines(st);
		if (eof(st)) break;
		const stmtLine = st.line;
		try {
			if (peek(st) === '[') {
				const opened = parseTableHeaderStatement(st, value, locations);
				currentTable = opened.table;
				currentPath = opened.path;
			} else {
				parseKeyValueStatement(st, currentTable, currentPath, locations, errors);
			}
		} catch (err) {
			errors.push({ line: err?.line ?? stmtLine, message: err?.message ?? String(err) });
			recoverToNextLine(st);
		}
	}

	return { value, locations, errors };
}

/**
 * @param {Map<string, {line: number, column: number}>} locations
 * @param {string[]} pathArray
 * @returns {number | null} 1-based line, or null when the path was never recorded.
 */
export function lineOfTomlKey(locations, pathArray) {
	if (!(locations instanceof Map) || !Array.isArray(pathArray)) return null;
	const entry = locations.get(JSON.stringify(pathArray));
	return entry ? entry.line : null;
}

function isPlainObject(v) {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArrayOfTables(v) {
	return Array.isArray(v) && v.length > 0 && v.every(isPlainObject);
}

function needsKeyQuoting(segment) {
	return /["'./ ]/.test(segment);
}

function quoteKeySegment(segment) {
	if (!needsKeyQuoting(segment)) return segment;
	return `"${segment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function dottedKey(pathSegs) {
	return pathSegs.map(quoteKeySegment).join('.');
}

function walkFlatten(node, pathSegs, out) {
	if (isPlainObject(node)) {
		for (const k of Object.keys(node)) walkFlatten(node[k], [...pathSegs, k], out);
		return;
	}
	if (isArrayOfTables(node)) {
		node.forEach((row, idx) => walkFlatten(row, [...pathSegs, String(idx)], out));
		return;
	}
	out.push({ path: pathSegs, key: dottedKey(pathSegs), value: node });
}

/**
 * @param {object} value a `value` tree as returned by `parseToml`
 * @param {{prefix?: string[]}} [options]
 * @returns {Array<{path: string[], key: string, value: *}>} one entry per leaf
 */
export function flattenToml(value, { prefix = [] } = {}) {
	const out = [];
	walkFlatten(value, prefix, out);
	return out;
}
