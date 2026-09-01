/**
 * Git context for the tree the panel is reading.
 *
 * WHY THIS EXISTS, and why the panel does NOT read from `dev` instead:
 *
 * About three quarters of what the panel inventories lives outside the repo
 * entirely — `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.claude.json`,
 * user skills, the plugin cache, session transcripts. Those have exactly one
 * reality per machine and no branch at all, so there is no "dev version" of
 * them to pin to.
 *
 * The remainder (`.claude/**` and `.ai-config/shared/rules/**`) is tracked and
 * does vary per branch. But reading those from `dev` while the session actually
 * runs against the working tree would make the panel describe a session that is
 * not happening. What governs your session is the tree you are in.
 *
 * So the panel keeps reading the working tree — the truth about the running
 * session — and this module supplies the missing half: which tree that is, and
 * where it DIVERGES from the anchor branch. Comparison, not substitution.
 *
 * Read-only: `rev-parse`, `diff --name-only`, `symbolic-ref`. No mutating git
 * subcommand, no shell string, always `execFileSync` with a timeout.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Both sides of a path comparison must be resolved before comparing. `git
 * rev-parse --show-toplevel` always returns the real path, while a caller's
 * projectRoot often arrives through a symlink — on macOS `/var` and `/tmp` are
 * themselves symlinks, so a raw string compare silently never matches.
 */
function realPath(target) {
	if (typeof target !== 'string' || target.length === 0) return null;
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

const GIT_TIMEOUT_MS = 10_000;
export const DEFAULT_ANCHOR_REF = 'dev';

/** Tracked config surfaces whose content is branch-dependent. */
export const TRACKED_CONFIG_PATHS = Object.freeze([
	'.claude',
	'.ai-config/shared/rules',
	'.vscode',
	'CLAUDE.md',
	'AGENTS.md',
]);

function git(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

/**
 * @param {{projectRoot: string, anchorRef?: string}} options
 * @returns {{available: boolean, error: string|null, root: string|null, branch: string|null,
 *   head: string|null, isMainWorktree: boolean, anchorRef: string, anchorHead: string|null,
 *   anchorExists: boolean, aheadOfAnchor: number|null, behindAnchor: number|null,
 *   divergingFiles: string[], machineScopeNote: string}}
 */
export function gitContext({ projectRoot, anchorRef = DEFAULT_ANCHOR_REF } = {}) {
	const base = {
		available: false,
		error: null,
		root: null,
		branch: null,
		head: null,
		isMainWorktree: false,
		anchorRef,
		anchorHead: null,
		anchorExists: false,
		aheadOfAnchor: null,
		behindAnchor: null,
		divergingFiles: [],
		machineScopeNote:
			'Most of what this panel reads lives outside the repo (~/.claude, ~/.claude.json, the plugin cache, transcripts). Those have one reality per machine and no branch — the comparison below applies only to tracked config.',
	};
	if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
		return { ...base, error: 'no projectRoot given' };
	}

	let root;
	try {
		root = git(projectRoot, ['rev-parse', '--show-toplevel']);
	} catch (error) {
		const stderr = error?.stderr ? String(error.stderr).trim() : '';
		return { ...base, error: stderr || String(error?.message || error) };
	}

	const result = { ...base, available: true, root };

	try {
		result.head = git(projectRoot, ['rev-parse', 'HEAD']);
	} catch {
		result.head = null;
	}
	try {
		result.branch = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
	} catch {
		result.branch = null;
	}
	try {
		// The main working tree is the first entry of `git worktree list`.
		const first = git(projectRoot, ['worktree', 'list', '--porcelain']).split('\n')[0] || '';
		const mainPath = first.startsWith('worktree ') ? first.slice('worktree '.length).trim() : null;
		result.isMainWorktree = mainPath !== null && path.resolve(mainPath) === path.resolve(root);
	} catch {
		result.isMainWorktree = false;
	}

	try {
		result.anchorHead = git(projectRoot, ['rev-parse', anchorRef]);
		result.anchorExists = true;
	} catch {
		// A missing anchor is reported, never silently treated as "no divergence".
		return { ...result, error: `anchor ref '${anchorRef}' not found` };
	}

	try {
		const counts = git(projectRoot, ['rev-list', '--left-right', '--count', `${anchorRef}...HEAD`]).split(/\s+/);
		result.behindAnchor = Number(counts[0]);
		result.aheadOfAnchor = Number(counts[1]);
	} catch {
		result.behindAnchor = null;
		result.aheadOfAnchor = null;
	}

	try {
		const out = git(projectRoot, ['diff', '--name-only', anchorRef, '--', ...TRACKED_CONFIG_PATHS]);
		result.divergingFiles = out.length > 0 ? out.split('\n').filter(Boolean) : [];
	} catch {
		result.divergingFiles = [];
	}

	return result;
}

/**
 * True when an absolute path is one of the tracked config files that currently
 * differs from the anchor branch. Used to badge a row as a branch-local
 * deviation rather than the canonical configuration.
 */
export function divergesFromAnchor(context, absPath) {
	if (!context?.available || !context.root || typeof absPath !== 'string') return false;
	const root = realPath(context.root);
	const target = realPath(absPath);
	if (!root || !target || !target.startsWith(`${root}/`)) return false;
	const relative = target.slice(root.length + 1);
	return context.divergingFiles.includes(relative);
}
