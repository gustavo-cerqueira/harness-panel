/**
 * Multi-project workspace root discovery and allowlisting.
 *
 * SECURITY IS THE POINT OF THIS MODULE. `?root=` on the HTTP API is resolved
 * against whatever `discoverWorkspaceRoots` returns here — if this module
 * returns something too broad, the panel becomes an arbitrary filesystem
 * reader. So the allowlist is built, not trusted:
 *
 *   - Only direct children of a configured base qualify, plus the bases
 *     themselves, plus the git worktrees of a repo found among them (a
 *     worktree can legitimately live outside the base, e.g. a sibling
 *     `repo-wt-*` directory).
 *   - Every candidate is resolved with `fs.realpathSync` and, for base
 *     children specifically, checked to still be inside the resolved base —
 *     a symlink planted under the base that points at `/etc` never becomes a
 *     root.
 *   - `isAllowedRoot` never re-derives roots from a caller-supplied string;
 *     it only ever checks membership in an already-computed discovery. A
 *     request-time `?root=` value is NEVER treated as a base to scan.
 *
 * Read-only: `git worktree list --porcelain`, `git rev-parse --verify
 * --quiet` and `git symbolic-ref --quiet` are the only child_process calls
 * this module makes, all read-only plumbing, always `execFileSync` with an
 * argument array, a timeout, and no shell string.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 10_000;
const DEFAULT_PREFERRED_ANCHOR = 'dev';

/** Resolves symlinks; returns null (never throws) for anything that does not exist. */
function realpathOrNull(candidate) {
	if (typeof candidate !== 'string' || candidate.length === 0) return null;
	try {
		return fs.realpathSync(candidate);
	} catch {
		return null;
	}
}

function isDirectorySafe(absPath) {
	try {
		return fs.statSync(absPath).isDirectory();
	} catch {
		return false;
	}
}

function hasDotGit(dir) {
	try {
		const stat = fs.statSync(path.join(dir, '.git'));
		return stat.isDirectory() || stat.isFile();
	} catch {
		return false;
	}
}

function hasClaudeDirOnDisk(dir) {
	try {
		return fs.statSync(path.join(dir, '.claude')).isDirectory();
	} catch {
		return false;
	}
}

function hasClaudeMdOnDisk(dir) {
	try {
		return fs.statSync(path.join(dir, 'CLAUDE.md')).isFile();
	} catch {
		return false;
	}
}

/** True when `resolvedPath` is `resolvedBase` itself or a descendant of it. */
function isInsideBase(resolvedPath, resolvedBase) {
	return resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + path.sep);
}

/**
 * Parses `git worktree list --porcelain` into `{ path, branch }` records.
 * Format (blank-line separated blocks): `worktree <path>`, `HEAD <sha>`,
 * `branch refs/heads/<name>` (absent when detached), plus flags this module
 * has no use for (`detached`, `bare`, `locked`, `prunable`).
 */
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
		if (line.startsWith('branch ')) {
			current.branch = line.slice('branch '.length);
		}
	}
	if (current) worktrees.push(current);
	return worktrees;
}

/** Runs `git worktree list --porcelain` from `dir`. Never throws. */
function listWorktrees(dir) {
	try {
		const stdout = execFileSync('git', ['worktree', 'list', '--porcelain'], {
			cwd: dir,
			encoding: 'utf8',
			timeout: GIT_TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return parseWorktreePorcelain(stdout);
	} catch {
		return [];
	}
}

function addRoot(collected, resolvedPath, gitFields) {
	if (collected.has(resolvedPath)) return;
	collected.set(resolvedPath, {
		path: resolvedPath,
		name: path.basename(resolvedPath),
		isGitRepo: gitFields.isGitRepo,
		isWorktree: gitFields.isWorktree,
		branch: gitFields.branch,
		mainWorktreePath: gitFields.mainWorktreePath,
		hasClaudeDir: hasClaudeDirOnDisk(resolvedPath),
		hasClaudeMd: hasClaudeMdOnDisk(resolvedPath),
	});
}

/**
 * Resolves one discovery candidate (a base itself, a base's direct child, or
 * an extra root) and, if it qualifies, adds it — and, when it is a git repo,
 * every worktree `git worktree list` reports for it — to `collected`.
 *
 * `enforceBaseResolved`, when given, is the resolved base this candidate is
 * supposed to live under; a symlink that resolves outside it is rejected
 * before any git command ever runs. Roots reached via worktree expansion, the
 * bases themselves, and extraRoots are intentionally exempt — they are
 * allowed to live outside any base by design.
 */
function buildRootsForCandidate(candidatePath, collected, enforceBaseResolved) {
	const resolved = realpathOrNull(candidatePath);
	if (!resolved) return;
	if (enforceBaseResolved && !isInsideBase(resolved, enforceBaseResolved)) return;
	if (!isDirectorySafe(resolved)) return;
	if (collected.has(resolved)) return;

	if (!hasDotGit(resolved)) {
		addRoot(collected, resolved, { isGitRepo: false, isWorktree: false, branch: null, mainWorktreePath: null });
		return;
	}

	const worktrees = listWorktrees(resolved);
	if (worktrees.length === 0) {
		// A `.git` entry exists but git could not read it (malformed pointer,
		// corrupt repo, permission error, ...). Degrade to a plain directory
		// rather than dropping the root entirely.
		addRoot(collected, resolved, { isGitRepo: false, isWorktree: false, branch: null, mainWorktreePath: null });
		return;
	}

	const mainEntry = worktrees[0];
	const mainResolved = realpathOrNull(mainEntry.path) ?? path.resolve(mainEntry.path);
	for (const wt of worktrees) {
		const wtResolved = realpathOrNull(wt.path);
		if (!wtResolved || !isDirectorySafe(wtResolved)) continue; // pruned/deleted worktree
		addRoot(collected, wtResolved, {
			isGitRepo: true,
			isWorktree: wtResolved !== mainResolved,
			branch: wt.branch,
			mainWorktreePath: mainResolved,
		});
	}
}

/**
 * @param {{home?: string, bases?: string[], extraRoots?: string[]}} options
 * @returns {{bases: {path: string, exists: boolean, error: string|null}[],
 *   roots: {path: string, name: string, isGitRepo: boolean, isWorktree: boolean,
 *     branch: string|null, mainWorktreePath: string|null, hasClaudeDir: boolean,
 *     hasClaudeMd: boolean}[], error: string|null}}
 */
export function discoverWorkspaceRoots({ home, bases, extraRoots } = {}) {
	const explicitBases = Array.isArray(bases) ? bases.filter((b) => typeof b === 'string' && b.length > 0) : [];
	const baseInputs =
		explicitBases.length > 0
			? explicitBases
			: typeof home === 'string' && home.length > 0
				? [path.join(home, 'projects')]
				: [];

	if (baseInputs.length === 0) {
		return { bases: [], roots: [], error: 'no home or bases given' };
	}

	const baseResults = [];
	const collected = new Map();

	for (const baseInput of baseInputs) {
		const resolvedBase = realpathOrNull(baseInput);
		if (!resolvedBase) {
			baseResults.push({ path: path.resolve(baseInput), exists: false, error: `base not found: ${baseInput}` });
			continue;
		}
		if (!isDirectorySafe(resolvedBase)) {
			baseResults.push({ path: resolvedBase, exists: false, error: `base is not a directory: ${baseInput}` });
			continue;
		}

		buildRootsForCandidate(resolvedBase, collected);

		let entries;
		try {
			entries = fs.readdirSync(resolvedBase, { withFileTypes: true });
		} catch (error) {
			baseResults.push({
				path: resolvedBase,
				exists: true,
				error: `cannot list base: ${String(error?.message || error)}`,
			});
			continue;
		}

		baseResults.push({ path: resolvedBase, exists: true, error: null });

		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			buildRootsForCandidate(path.join(resolvedBase, entry.name), collected, resolvedBase);
		}
	}

	for (const extra of Array.isArray(extraRoots) ? extraRoots : []) {
		buildRootsForCandidate(extra, collected);
	}

	const roots = Array.from(collected.values()).sort((a, b) => a.name.localeCompare(b.name));

	return { bases: baseResults, roots, error: null };
}

/**
 * Validates a caller-supplied `?root=` value against an already-computed
 * discovery. This NEVER re-derives roots from `candidatePath` — it only
 * checks membership — so a request-time string can never expand the
 * allowlist, only fail to match it.
 *
 * @param {ReturnType<typeof discoverWorkspaceRoots>} discovery
 * @param {string|null|undefined} candidatePath
 * @returns {boolean}
 */
export function isAllowedRoot(discovery, candidatePath) {
	if (!discovery || !Array.isArray(discovery.roots)) return false;
	if (typeof candidatePath !== 'string' || candidatePath.length === 0) return false;
	if (!path.isAbsolute(candidatePath)) return false;
	if (candidatePath.includes('..')) return false;

	const resolved = realpathOrNull(candidatePath);
	if (!resolved) return false;
	if (resolved.includes('..')) return false; // belt-and-suspenders; realpath already resolves these away
	if (!isDirectorySafe(resolved)) return false;

	return discovery.roots.some((root) => root.path === resolved);
}

function verifyRefExists(projectRoot, ref) {
	try {
		execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
			cwd: projectRoot,
			encoding: 'utf8',
			timeout: GIT_TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return true;
	} catch {
		return false;
	}
}

/** Strips the `refs/remotes/origin/` prefix from `origin/HEAD`'s target, or null. */
function defaultBranchFromOriginHead(projectRoot) {
	try {
		const out = execFileSync('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
			cwd: projectRoot,
			encoding: 'utf8',
			timeout: GIT_TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
		const prefix = 'refs/remotes/origin/';
		return out.startsWith(prefix) ? out.slice(prefix.length) : null;
	} catch {
		return null;
	}
}

/**
 * Resolves the branch the panel should diff the working tree against.
 * `dev` is hardcoded elsewhere in this panel today; this is the per-repo
 * replacement. Tries `preferred`, then `main`, then `master`, then the
 * repo's own default branch via `origin/HEAD`. Never invents a ref: if none
 * resolve, `ref` is null and `source` is `'none'`, with the real error.
 *
 * @param {{projectRoot: string, preferred?: string}} options
 * @returns {{ref: string|null, source: 'preferred'|'fallback'|'default-branch'|'none',
 *   tried: string[], error: string|null}}
 */
export function resolveAnchorRef({ projectRoot, preferred = DEFAULT_PREFERRED_ANCHOR } = {}) {
	const tried = [];
	if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
		return { ref: null, source: 'none', tried, error: 'no projectRoot given' };
	}

	const candidates = [];
	const seen = new Set();
	const pushCandidate = (ref, source) => {
		if (typeof ref !== 'string' || ref.length === 0 || seen.has(ref)) return;
		seen.add(ref);
		candidates.push({ ref, source });
	};
	pushCandidate(preferred, 'preferred');
	pushCandidate('main', 'fallback');
	pushCandidate('master', 'fallback');

	for (const candidate of candidates) {
		tried.push(candidate.ref);
		if (verifyRefExists(projectRoot, candidate.ref)) {
			return { ref: candidate.ref, source: candidate.source, tried, error: null };
		}
	}

	const defaultBranch = defaultBranchFromOriginHead(projectRoot);
	if (defaultBranch && !seen.has(defaultBranch)) {
		tried.push(defaultBranch);
		if (verifyRefExists(projectRoot, defaultBranch)) {
			return { ref: defaultBranch, source: 'default-branch', tried, error: null };
		}
	}

	return {
		ref: null,
		source: 'none',
		tried,
		error: `no anchor ref resolved (tried: ${tried.join(', ') || 'none'})`,
	};
}
