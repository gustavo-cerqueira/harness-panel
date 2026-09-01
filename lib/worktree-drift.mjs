/**
 * Cross-worktree drift for `.claude/settings.local.json`.
 *
 * A repository can run dozens of git worktrees off one shared `.git`. Each worktree gets
 * its own `.claude/settings.local.json` — per-machine, git-untracked, and
 * rewritten by Claude Code on every "always allow". Nothing keeps these files
 * in sync, so they drift independently. This module answers "which worktrees
 * disagree with the main checkout's copy, and how do they disagree" — because
 * "the file is different" and "the file doesn't exist" are different problems
 * and the UI should never blur them together.
 *
 * READ ONLY, with one narrow exception: `git worktree list --porcelain` is the
 * single child_process call this module is allowed to make. It is read-only
 * git plumbing (lists worktrees; mutates nothing), invoked with execFileSync
 * and an argument array — never a shell string, never any other subcommand.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readSourceFile, vscodeLink } from './source-file.mjs';
import { worktreeSettingsPath } from './layers.mjs';

const GIT_TIMEOUT_MS = 10_000;

/** Resolves symlinks when possible; falls back to a plain absolute path for
 * roots that do not exist (a worktree can be deleted out from under its git
 * metadata, and this must not throw when that happens). */
function resolvePathSafe(candidate) {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

/**
 * Parses `git worktree list --porcelain` into one record per worktree.
 * Format (blank-line separated blocks):
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>      (absent when detached)
 *   detached                      (present instead of `branch` when detached)
 *   bare                          (present for the bare admin worktree, if any)
 *   locked [<reason>]
 *   prunable [<reason>]
 */
function parseWorktreePorcelain(stdout) {
	const worktrees = [];
	let current = null;
	for (const line of stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			if (current) worktrees.push(current);
			current = { path: line.slice('worktree '.length), branch: null, head: null };
			continue;
		}
		if (!current) continue; // stray line before the first `worktree` header
		if (line.startsWith('HEAD ')) {
			current.head = line.slice('HEAD '.length);
		} else if (line.startsWith('branch ')) {
			current.branch = line.slice('branch '.length);
		}
		// `detached`, `bare`, `locked`, `prunable` and blank separators carry no
		// field this module reports and are intentionally ignored.
	}
	if (current) worktrees.push(current);
	return worktrees;
}

function sha256Hex(content) {
	return crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

/**
 * Classifies a `readSourceFile` result into the three states the drift logic
 * needs to distinguish: a real file we can hash, a path that exists but could
 * not be read as a file (permission error, or a directory sitting where the
 * file should be), or a path that plainly does not exist.
 */
function classifyFile(file) {
	if (file.exists && file.readable && typeof file.content === 'string') {
		return { state: 'present', sha256: sha256Hex(file.content), bytes: Buffer.byteLength(file.content, 'utf8') };
	}
	if (file.exists && !file.readable) {
		return { state: 'unreadable', sha256: null, bytes: null };
	}
	return { state: 'absent', sha256: null, bytes: null };
}

/**
 * `hasMain` is false when `projectRoot` did not match any worktree git knows
 * about at all — a genuinely different situation from "the main checkout has
 * no settings file", which is `mainState.state === 'absent'`.
 */
function classifyDrift({ isMain, hasMain, ownState, mainState }) {
	if (isMain) return { driftKind: 'same', drifted: false };
	if (!hasMain || ownState.state === 'unreadable' || mainState.state === 'unreadable') {
		return { driftKind: 'unknown', drifted: false };
	}
	if (ownState.state === 'present' && mainState.state === 'present') {
		const same = ownState.sha256 === mainState.sha256;
		return { driftKind: same ? 'same' : 'different', drifted: !same };
	}
	if (ownState.state === 'absent' && mainState.state === 'absent') {
		return { driftKind: 'same', drifted: false };
	}
	if (ownState.state === 'absent' && mainState.state === 'present') {
		return { driftKind: 'missing-here', drifted: true };
	}
	// ownState.state === 'present' && mainState.state === 'absent'
	return { driftKind: 'missing-in-main', drifted: true };
}

/**
 * @param {{projectRoot: string}} options
 * @returns {{worktrees: object[], error?: string}}
 */
export function scanWorktreeDrift({ projectRoot } = {}) {
	if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
		return { worktrees: [], error: 'no projectRoot given' };
	}

	let stdout;
	try {
		stdout = execFileSync('git', ['worktree', 'list', '--porcelain'], {
			cwd: projectRoot,
			encoding: 'utf8',
			timeout: GIT_TIMEOUT_MS,
		});
	} catch (error) {
		const stderr = error?.stderr ? String(error.stderr).trim() : '';
		return { worktrees: [], error: stderr.length > 0 ? stderr : String(error?.message || error) };
	}

	const parsed = parseWorktreePorcelain(stdout);
	if (parsed.length === 0) {
		return { worktrees: [], error: 'git worktree list --porcelain returned no worktrees' };
	}

	const resolvedProjectRoot = resolvePathSafe(projectRoot);
	const entries = parsed.map((wt) => ({ ...wt, resolvedPath: resolvePathSafe(wt.path) }));

	// The drift baseline is git's MAIN working tree — always the first entry of
	// `git worktree list --porcelain` — not whatever directory the panel happened
	// to be launched from. Using projectRoot as the baseline makes every other
	// worktree read "missing-in-main" the moment you start the panel from inside
	// a feature worktree, which is noise, not drift.
	const mainEntry = entries[0] ?? null;

	const mainSettingsPath = mainEntry ? worktreeSettingsPath(mainEntry.path) : null;
	const mainState = mainEntry
		? classifyFile(readSourceFile(mainSettingsPath))
		: { state: 'absent', sha256: null, bytes: null };

	const worktrees = entries.map((wt) => {
		const isMain = mainEntry !== null && wt.resolvedPath === mainEntry.resolvedPath;
		const settingsPath = worktreeSettingsPath(wt.path);
		const file = readSourceFile(settingsPath);
		const ownState = classifyFile(file);
		const { driftKind, drifted } = classifyDrift({ isMain, hasMain: mainEntry !== null, ownState, mainState });

		return {
			path: wt.path,
			branch: wt.branch,
			head: wt.head,
			isMain,
			isCurrent: wt.resolvedPath === resolvedProjectRoot,
			settingsPath,
			exists: ownState.state === 'present',
			sha256: ownState.sha256,
			bytes: ownState.bytes,
			drifted,
			driftKind,
			link: vscodeLink(settingsPath, 1),
			error: file.error,
		};
	});

	return { worktrees };
}

/**
 * @param {object[]} rows output of `scanWorktreeDrift(...).worktrees`
 * @returns {{total: number, same: number, different: number, missing: number, mainSha256: string|null}}
 */
export function driftSummary(rows) {
	const list = Array.isArray(rows) ? rows : [];
	const summary = { total: list.length, same: 0, different: 0, missing: 0, mainSha256: null };
	for (const row of list) {
		if (row.isMain) summary.mainSha256 = row.sha256 ?? null;
		if (row.driftKind === 'same') summary.same += 1;
		else if (row.driftKind === 'different') summary.different += 1;
		else if (row.driftKind === 'missing-here' || row.driftKind === 'missing-in-main') summary.missing += 1;
	}
	return summary;
}
