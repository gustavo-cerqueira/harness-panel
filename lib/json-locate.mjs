/**
 * Maps every key in a JSON document to the 1-based line where it is defined.
 *
 * The panel deep-links each row to `vscode://file/<abs-path>:<line>`, so it
 * needs the position of a key in the RAW TEXT — something `JSON.parse` throws
 * away. This is a tolerant scanner rather than a validating parser: a truncated
 * or malformed file still yields the positions it managed to read, because a
 * broken settings file is exactly when you most want the jump-to-source link.
 *
 * Paths use dotted keys and bracketed array indices:
 *   permissions.allow[0]
 *   hooks.PostToolUse[0].hooks[0].command
 */

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

function joinKey(prefix, key) {
	return prefix ? `${prefix}.${key}` : String(key);
}

/**
 * Path prefix that a container opening at the current position would receive.
 * Derived from the parent frame's cursor: the key it last read (object) or the
 * element index it is on (array).
 */
function currentValuePrefix(stack) {
	if (stack.length === 0) return '';
	const top = stack[stack.length - 1];
	if (top.type === 'object') {
		return top.key == null ? top.prefix : joinKey(top.prefix, top.key);
	}
	return `${top.prefix}[${top.index}]`;
}

/**
 * Reads one JSON string token starting at `start` (which must be the opening
 * quote). Returns the decoded value, the index just past the closing quote, and
 * how many raw newlines were consumed so the caller can keep its line counter
 * accurate.
 */
function readString(text, start) {
	let i = start + 1;
	let value = '';
	let newlines = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\\') {
			const next = text[i + 1];
			if (next === 'u') {
				const code = Number.parseInt(text.slice(i + 2, i + 6), 16);
				value += Number.isNaN(code) ? '' : String.fromCharCode(code);
				i += 6;
				continue;
			}
			const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
			value += Object.hasOwn(simple, next) ? simple[next] : (next ?? '');
			if (next === 'n') newlines += 0; // escaped newline is not a raw line break
			i += 2;
			continue;
		}
		if (ch === '"') {
			i += 1;
			break;
		}
		if (ch === '\n') newlines += 1; // tolerated: invalid JSON, but we keep counting
		value += ch;
		i += 1;
	}
	return { value, end: i, newlines };
}

/**
 * @param {string} text raw file contents
 * @returns {Map<string, number>} path -> 1-based line number
 */
export function locateJsonPaths(text) {
	const index = new Map();
	if (typeof text !== 'string' || text.length === 0) return index;

	const stack = [];
	let i = 0;
	let line = 1;

	/**
	 * Array elements have no key to anchor them, so their position is recorded
	 * when their first token is seen. First token wins: a multi-line element
	 * links to where it starts, not where it ends.
	 */
	const noteArrayElement = (atLine) => {
		const top = stack[stack.length - 1];
		if (top?.type !== 'array') return;
		const path = `${top.prefix}[${top.index}]`;
		if (!index.has(path)) index.set(path, atLine);
	};

	while (i < text.length) {
		const ch = text[i];

		if (ch === '\n') {
			line += 1;
			i += 1;
			continue;
		}
		if (WHITESPACE.has(ch)) {
			i += 1;
			continue;
		}
		if (ch === '{' || ch === '[') {
			noteArrayElement(line);
			stack.push({
				type: ch === '{' ? 'object' : 'array',
				prefix: currentValuePrefix(stack),
				key: null,
				index: 0,
			});
			i += 1;
			continue;
		}
		if (ch === '}' || ch === ']') {
			stack.pop();
			i += 1;
			continue;
		}
		if (ch === ',') {
			const top = stack[stack.length - 1];
			if (top?.type === 'array') top.index += 1;
			else if (top) top.key = null;
			i += 1;
			continue;
		}
		if (ch === ':') {
			i += 1;
			continue;
		}
		if (ch === '"') {
			const startLine = line;
			noteArrayElement(startLine);
			const { value, end, newlines } = readString(text, i);
			line += newlines;
			i = end;

			// A string is a KEY only when the next significant character is ':'.
			let j = i;
			while (j < text.length && WHITESPACE.has(text[j])) j += 1;
			if (text[j] === ':') {
				const top = stack[stack.length - 1];
				if (top?.type === 'object') {
					top.key = value;
					index.set(joinKey(top.prefix, value), startLine);
				}
			}
			continue;
		}

		// Primitive token (number / true / false / null): consume to the next
		// structural character without interpreting it. The array-element guard
		// keeps the first line, so scanning it character by character is safe.
		noteArrayElement(line);
		i += 1;
	}

	return index;
}

/**
 * Resolves a path to a line, degrading to the nearest known ancestor instead of
 * guessing. Always returns a usable line so a deep link is never broken; line 1
 * means "file found, exact position unknown".
 */
export function lineOf(index, path) {
	if (!(index instanceof Map) || typeof path !== 'string' || path.length === 0) return 1;
	let candidate = path;
	while (candidate) {
		if (index.has(candidate)) return index.get(candidate);
		const cut = Math.max(candidate.lastIndexOf('['), candidate.lastIndexOf('.'));
		if (cut <= 0) break;
		candidate = candidate.slice(0, cut);
	}
	return index.has(candidate) ? index.get(candidate) : 1;
}
