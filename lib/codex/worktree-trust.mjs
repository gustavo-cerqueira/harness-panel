/**
 * Codex counterpart of `../worktree-drift.mjs`, but a different question:
 * Claude Code's worktree section asks "does this worktree's settings file
 * MATCH the main checkout's" (a content-drift question); Codex has no
 * per-worktree settings file to drift -- it has a per-path TRUST decision
 * in `config.toml`, and the question is "does this worktree's path resolve
 * to a trusted entry at all".
 *
 * LOOKUP ORDER (confirmed against Codex 0.149.1 `git-utils/src/trust.rs`,
 * 2026-08-26 report): exact canonical path entry -> detected project-root
 * path -> main git repository root. For every worktree this panel scans
 * (always scanned AT its own root, never a subdirectory below it), the
 * "detected project-root path" step is identical to the exact-path step --
 * a linked worktree's root IS its own project root -- so this module
 * collapses those two into one exact-match check and documents the
 * simplification rather than pretending to implement a third, redundant
 * step. There is NO ancestor-prefix inheritance: `[projects."/Users/x"]`
 * being trusted does NOT trust `/Users/x/anything` -- only an exact entry
 * for that path, or (for a linked worktree) the MAIN checkout's own exact
 * entry, ever grants trust.
 *
 * `sha256`/`bytes` are always `null` here (unlike the Claude module): there
 * is no per-worktree file to hash for a trust question, only a config.toml
 * line to point at.
 *
 * READ ONLY, with one narrow exception: `git worktree list --porcelain` is
 * the single child_process call this module makes, via execFileSync with an
 * argument array -- never a shell string, never any other subcommand. Same
 * discipline as `../worktree-drift.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSourceFile, vscodeLink } from '../source-file.mjs';
import { parseToml, lineOfTomlKey } from './toml.mjs';
import { resolveCodexPaths } from './layers.mjs';

const GIT_TIMEOUT_MS = 10_000;

function resolvePathSafe(candidate) {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

/** Parses `git worktree list --porcelain` into `{path, branch}` records. */
function parseWorktreePorcelain(stdout) {
	const worktrees = [];
	let current = null;
	for (const line of stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			if (current) worktrees.push(current);
			current = { path: line.slice('worktree '.length), branch: null };
			continue;
		}
		if (!current) continue;
		if (line.startsWith('branch ')) current.branch = line.slice('branch '.length);
		// `HEAD`, `detached`, `bare`, `locked`, `prunable` carry no field this
		// module reports and are intentionally ignored.
	}
	if (current) worktrees.push(current);
	return worktrees;
}

/**
 * @param {{home: string, projectRoot: string}} options
 * @returns {{worktrees: object[], error?: string}}
 */
export function scanWorktreeTrust({ home, projectRoot } = {}) {
	if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
		return { worktrees: [], error: 'no projectRoot given' };
	}
	if (typeof home !== 'string' || home.length === 0) {
		return { worktrees: [], error: 'no home given' };
	}

	const paths = resolveCodexPaths({ home, projectRoot });
	const configPath = paths.user.config;
	const configFile = readSourceFile(configPath);
	const configError = !configFile.readable ? configFile.error : null;
	const toml =
		configFile.readable && configFile.content != null
			? parseToml(configFile.content)
			: { value: {}, locations: new Map(), errors: [] };

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

	const entries = parsed.map((wt) => ({ ...wt, resolvedPath: resolvePathSafe(wt.path) }));
	// git's first entry is always the main working tree -- same convention
	// ../worktree-drift.mjs relies on, and the one Codex's own trust
	// resolution falls back to for a linked worktree.
	const mainEntry = entries[0];

	/** Looks up `[projects."<absPath>"]` by exact string, trying the raw and realpath'd spellings. */
	function trustEntryFor(rawPath, resolvedPath) {
		for (const candidate of [rawPath, resolvedPath]) {
			const line = lineOfTomlKey(toml.locations, ['projects', candidate]);
			if (line == null) continue;
			const trustLevel = toml.value?.projects?.[candidate]?.trust_level;
			return { trusted: trustLevel === 'trusted', line };
		}
		return null;
	}

	const worktrees = entries.map((wt) => {
		const isMain = wt.resolvedPath === mainEntry.resolvedPath;
		const exact = trustEntryFor(wt.path, wt.resolvedPath);

		let driftKind;
		let trustSource;
		let line = null;

		if (exact) {
			driftKind = exact.trusted ? 'trusted-exact' : 'untrusted';
			trustSource = 'exact entry';
			line = exact.line;
		} else if (!isMain) {
			const viaMain = trustEntryFor(mainEntry.path, mainEntry.resolvedPath);
			if (viaMain?.trusted) {
				driftKind = 'trusted-via-main';
				trustSource = 'main checkout entry';
				line = viaMain.line;
			} else {
				driftKind = 'untrusted';
				trustSource = 'none';
			}
		} else {
			driftKind = 'untrusted';
			trustSource = 'none';
		}

		return {
			path: wt.path,
			branch: wt.branch,
			isMain,
			settingsPath: configPath,
			line,
			link: line ? vscodeLink(configPath, line) : null,
			driftKind,
			trustSource,
			sha256: null,
			bytes: null,
			error: configError,
		};
	});

	return { worktrees };
}

/**
 * @param {object[]} rows output of `scanWorktreeTrust(...).worktrees`
 * @returns {{total: number, trustedExact: number, trustedViaMain: number, untrusted: number}}
 */
export function trustSummary(rows) {
	const list = Array.isArray(rows) ? rows : [];
	const summary = { total: list.length, trustedExact: 0, trustedViaMain: 0, untrusted: 0 };
	for (const row of list) {
		if (row.driftKind === 'trusted-exact') summary.trustedExact += 1;
		else if (row.driftKind === 'trusted-via-main') summary.trustedViaMain += 1;
		else if (row.driftKind === 'untrusted') summary.untrusted += 1;
	}
	return summary;
}
