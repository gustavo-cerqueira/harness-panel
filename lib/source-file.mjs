/**
 * The single read primitive for the whole panel.
 *
 * Every scanner goes through here so three properties hold everywhere:
 *   - READ ONLY: `fs.readFileSync` and `fs.lstatSync` only. No write call
 *     exists in this module, which is what makes the read-only guarantee
 *     checkable by grep rather than by trust.
 *   - HONEST: a missing, unreadable or malformed file returns the real error
 *     and the real path. Never an empty object standing in for data.
 *   - LINKABLE: JSON reads carry a line index so any key can be turned into a
 *     `vscode://file/<abs>:<line>` deep link.
 */
import fs from 'node:fs';
import path from 'node:path';
import { locateJsonPaths } from './json-locate.mjs';

const CHARS_PER_TOKEN = 4;

/**
 * @param {string} absPath
 * @returns {{path: string, exists: boolean, readable: boolean, isSymlink: boolean,
 *   symlinkTarget: string|null, size: number|null, mtimeMs: number|null,
 *   content: string|null, error: string|null}}
 */
export function readSourceFile(absPath) {
	const base = {
		path: absPath,
		exists: false,
		readable: false,
		isSymlink: false,
		symlinkTarget: null,
		size: null,
		mtimeMs: null,
		content: null,
		error: null,
	};
	if (typeof absPath !== 'string' || absPath.length === 0) {
		return { ...base, error: 'no path given' };
	}

	let stat;
	try {
		stat = fs.lstatSync(absPath);
	} catch (error) {
		return { ...base, error: String(error?.message || error) };
	}

	const result = { ...base, exists: true, mtimeMs: stat.mtimeMs };

	if (stat.isSymbolicLink()) {
		result.isSymlink = true;
		try {
			result.symlinkTarget = fs.realpathSync(absPath);
		} catch (error) {
			result.symlinkTarget = null;
			result.error = `broken symlink: ${String(error?.message || error)}`;
			return result;
		}
	}

	if (stat.isDirectory()) {
		return { ...result, error: 'path is a directory, not a file' };
	}

	try {
		const content = fs.readFileSync(absPath, 'utf8');
		return { ...result, readable: true, content, size: Buffer.byteLength(content, 'utf8') };
	} catch (error) {
		return { ...result, error: String(error?.message || error) };
	}
}

/**
 * Reads a JSON file. `json` is null when the file is absent OR malformed — the
 * two cases are told apart by `exists` and `parseError`, never conflated.
 */
export function readJsonFile(absPath) {
	const file = readSourceFile(absPath);
	const result = { ...file, json: null, parseError: null, lineIndex: new Map() };
	if (!file.readable || file.content == null) return result;

	result.lineIndex = locateJsonPaths(file.content);
	try {
		result.json = JSON.parse(file.content);
	} catch (error) {
		result.parseError = String(error?.message || error);
	}
	return result;
}

/**
 * Builds the editor deep link. Relative paths are refused rather than turned
 * into a link that silently opens the wrong file.
 */
export function vscodeLink(absPath, line = 1) {
	if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return null;
	const safeLine = Number.isInteger(line) && line > 0 ? line : 1;
	return `vscode://file${absPath}:${safeLine}`;
}

/** Rough token estimate: characters divided by four, the usual approximation. */
export function estimateTokens(content) {
	if (typeof content !== 'string' || content.length === 0) return 0;
	return Math.round(content.length / CHARS_PER_TOKEN);
}
