/**
 * The CLAUDE.md instruction chain, in load order.
 *
 * Claude Code's memory system has its own small taxonomy, distinct from the
 * settings cascade in `lib/layers.mjs`:
 *   - `user`            ~/.claude/CLAUDE.md            -- always injected
 *   - `project`         <projectRoot>/.claude/CLAUDE.md -- always injected
 *   - `project-symlink` <projectRoot>/AGENTS.md         -- a symlink alias of
 *                        the project memory file; never counted twice
 *   - `nested`          any other CLAUDE.md under <projectRoot>, loaded only
 *                        when work touches the directory it scopes
 *
 * Every entry goes through `readSourceFile` so a missing/unreadable file
 * surfaces the real path and the real error, never a fabricated placeholder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, readSourceFile, vscodeLink } from './source-file.mjs';
import { resolveLayerPaths } from './layers.mjs';
import { redactText } from './mask.mjs';

/** Bytes above which a memory file is flagged as worth trimming. */
export const LARGE_MEMORY_FILE_CHARS = 40000;

/** Directory names the nested walk never descends into. */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build']);

const HEADING_PATTERN = /^(#{1,6})\s+(\S.*?)\s*$/;
const FENCE_PATTERN = /^(```|~~~)/;

/**
 * Extracts every ATX heading from markdown content, with a deep link each.
 * Fence-aware: a `#` line inside an open ``` or ~~~ fenced code block is a
 * shell comment or similar, never a heading, and is skipped while the fence
 * is open. The fence must be closed by the SAME marker that opened it (a
 * ``` fence is not closed by a ~~~ line), matching CommonMark.
 */
function extractHeadings(content, absPath) {
	if (typeof content !== 'string' || content.length === 0) return [];
	const headings = [];
	const lines = content.split('\n');
	let fenceMarker = null;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const fenceMatch = FENCE_PATTERN.exec(line.trim());
		if (fenceMatch) {
			if (!fenceMarker) {
				fenceMarker = fenceMatch[1];
			} else if (line.trim().startsWith(fenceMarker)) {
				fenceMarker = null;
			}
			continue;
		}
		if (fenceMarker) continue;

		const match = HEADING_PATTERN.exec(line);
		if (!match) continue;
		const lineNumber = i + 1;
		headings.push({ text: match[2], level: match[1].length, line: lineNumber, link: vscodeLink(absPath, lineNumber) });
	}
	return headings;
}

/** True when any path segment is literally "undefined" -- a known corrupt-path smell. */
function hasUndefinedSegment(absPath) {
	return absPath.split(path.sep).includes('undefined');
}

/** Builds one chain entry by reading `absPath` through the shared read primitive. */
function buildEntry({ layer, absPath, alwaysInjected, scopeDir }) {
	const file = readSourceFile(absPath);
	const bytes = file.size ?? 0;
	const content = file.readable ? file.content : null;
	return {
		layer,
		path: absPath,
		exists: file.exists,
		isSymlink: file.isSymlink,
		symlinkTarget: file.symlinkTarget,
		bytes,
		estimatedTokens: estimateTokens(content ?? ''),
		alwaysInjected,
		// The file body ships in the API for snapshot diffs; credentials written in
		// prose (a sanctioned smoke-test login lives in this repo's CLAUDE.md) are
		// masked here so /api/state never carries a password.
		content: content == null ? content : redactText(content),
		headings: extractHeadings(content, absPath),
		link: vscodeLink(absPath, 1),
		error: file.error,
		tripsLargeFileWarning: bytes > LARGE_MEMORY_FILE_CHARS,
		scopeDir: scopeDir ?? null,
	};
}

/**
 * Recursively finds every file literally named `CLAUDE.md` under `dir`,
 * skipping the usual noise directories and any already-known chain path.
 * Symlinked directories are never followed, so a symlink cycle cannot hang
 * the walk; a symlinked CLAUDE.md file is still reported (as a symlink).
 */
function walkForNestedMemoryFiles(dir, exclude, results) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		// Unreadable directory (permissions, race with a concurrent delete): this
		// is a best-effort discovery walk, so skip it rather than throw and abort
		// discovery of every sibling directory.
		return;
	}

	for (const dirent of entries) {
		const abs = path.join(dir, dirent.name);
		if (hasUndefinedSegment(abs)) continue;

		if (dirent.isSymbolicLink()) {
			let real;
			try {
				real = fs.statSync(abs);
			} catch {
				continue; // broken symlink: nothing to walk into or read
			}
			if (real.isDirectory()) continue; // never follow a symlinked directory
			if (real.isFile() && dirent.name === 'CLAUDE.md' && !exclude.has(abs)) results.push(abs);
			continue;
		}

		if (dirent.isDirectory()) {
			if (SKIP_DIR_NAMES.has(dirent.name)) continue;
			walkForNestedMemoryFiles(abs, exclude, results);
			continue;
		}

		if (dirent.isFile() && dirent.name === 'CLAUDE.md' && !exclude.has(abs)) {
			results.push(abs);
		}
	}
}

/**
 * @param {{home: string, projectRoot: string}} options
 * @returns {object[]} chain entries in load order
 */
export function scanMemoryChain({ home, projectRoot }) {
	const paths = resolveLayerPaths({ home, projectRoot });
	const entries = [];

	const userMemoryPath = paths.user.memory;
	entries.push(buildEntry({ layer: 'user', absPath: userMemoryPath, alwaysInjected: true, scopeDir: null }));

	const projectMemoryPath = paths.project.memory;
	entries.push(
		buildEntry({ layer: 'project', absPath: projectMemoryPath, alwaysInjected: true, scopeDir: projectRoot }),
	);

	const agentsSymlinkPath = paths.project.agentsSymlink;
	entries.push(
		buildEntry({
			layer: 'project-symlink',
			absPath: agentsSymlinkPath,
			alwaysInjected: false,
			scopeDir: projectRoot,
		}),
	);

	const exclude = new Set([userMemoryPath, projectMemoryPath, agentsSymlinkPath]);
	const nestedPaths = [];
	walkForNestedMemoryFiles(projectRoot, exclude, nestedPaths);
	nestedPaths.sort();
	for (const absPath of nestedPaths) {
		entries.push(buildEntry({ layer: 'nested', absPath, alwaysInjected: false, scopeDir: path.dirname(absPath) }));
	}

	return entries;
}

/**
 * Totals over the always-injected slice of the chain only. A symlink whose
 * target resolves to an already-counted file is never counted twice, because
 * the identity used for dedup is the real target when one exists.
 *
 * @param {object[]} entries
 */
export function memoryChainTotals(entries) {
	const list = Array.isArray(entries) ? entries : [];
	const seen = new Set();
	let alwaysInjectedBytes = 0;
	let alwaysInjectedTokens = 0;
	let fileCount = 0;

	for (const entry of list) {
		if (!entry?.alwaysInjected) continue;
		const identity = entry.isSymlink && entry.symlinkTarget ? entry.symlinkTarget : entry.path;
		if (seen.has(identity)) continue;
		seen.add(identity);
		alwaysInjectedBytes += entry.bytes ?? 0;
		alwaysInjectedTokens += entry.estimatedTokens ?? 0;
		fileCount += 1;
	}

	return { alwaysInjectedBytes, alwaysInjectedTokens, fileCount };
}
