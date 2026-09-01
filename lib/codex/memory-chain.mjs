/**
 * The AGENTS.md instruction chain Codex CLI injects into a session, in load
 * order. Codex counterpart of `../memory-chain.mjs`.
 *
 * Facts below are Codex 0.149.1 `agents_md.rs` semantics as reported by Codex
 * on 2026-08-26 (see the shared scanner contract's CODEX-CONFIRMED FACTS
 * section and `codex-report.md` section 1):
 *
 *   - User scope: the first NON-EMPTY file of `$CODEX_HOME/AGENTS.override.md`,
 *     then `$CODEX_HOME/AGENTS.md` -- always injected.
 *   - Project scope: Codex walks from the session cwd up to a `project_root_markers`
 *     directory (default `.git`), then reads every directory from that root DOWN
 *     TO the cwd, inclusive, taking AT MOST ONE file per directory in the order
 *     `AGENTS.override.md` -> `AGENTS.md` -> `project_doc_fallback_filenames`.
 *     A non-empty override REPLACES AGENTS.md in the same directory outright --
 *     it does not merge with it.
 *   - `project_doc_max_bytes` (default 32 KiB) is a TOTAL byte budget over the
 *     concatenated project files, root-to-leaf; a file that would exceed the
 *     remaining budget is truncated to the remainder. The user file is never
 *     charged against it.
 *   - Symlinks are followed and injected in full (this repo's own AGENTS.md ->
 *     .claude/CLAUDE.md is the proof: `world_state.agents_md.text` carries the
 *     complete resolved target).
 *
 * HONEST LIMITS (the panel has no live session):
 *   - There is no real Codex session cwd to read here, so this scanner treats
 *     `projectRoot` AS the cwd. That collapses the documented "root down to cwd"
 *     walk to exactly one directory (the project root itself) -- there is no
 *     intermediate directory to inventory as part of the injected chain. Any
 *     AGENTS.md/AGENTS.override.md found in a subdirectory is reported as an
 *     on-demand CANDIDATE (`alwaysInjected: false`), never as part of the
 *     actually-injected chain, because it would only load if a session's cwd
 *     were inside that directory.
 *   - "Non-empty" governs the override-vs-plain choice at user scope per the
 *     confirmed fact above; this scanner applies the same non-empty rule at
 *     project scope too (an existing-but-empty AGENTS.override.md falls through
 *     to AGENTS.md) for consistency. Codex's own report does not spell out the
 *     empty-file case at project scope explicitly -- flag this if real Codex
 *     behaviour turns out to treat "exists" and "non-empty" differently there.
 *   - "Empty files do not consume the resulting instruction entry" (a report
 *     nuance about how the budget accounts for zero-byte files) is not modelled
 *     as separate behaviour here; with the root-only chain this panel builds,
 *     an empty root file simply contributes zero bytes toward the budget, which
 *     has the same practical effect.
 *   - The nested-candidate walk is BOUNDED (max depth 6 below the project root,
 *     skipping `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`) for
 *     the same reason `../memory-chain.mjs` bounds its own walk: a full,
 *     unbounded recursive scan of a large monorepo on every request is not
 *     worth the completeness it buys, and Codex only ever reads ONE such file
 *     per directory as a session's cwd moves through the tree, never the whole
 *     subtree at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, readSourceFile, vscodeLink } from '../source-file.mjs';
import { resolveCodexPaths } from './layers.mjs';

/** Codex's `project_doc_max_bytes` default: a 32 KiB TOTAL budget over the project chain. */
export const PROJECT_DOC_MAX_BYTES = 32 * 1024;

/** Directory names the nested candidate walk never descends into. */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

/** How many directory levels below the project root the candidate walk explores. */
const MAX_NESTED_DEPTH = 6;

const HEADING_PATTERN = /^(#{1,6})\s+(\S.*?)\s*$/;

const REPLACED_NOTE =
	'Shadowed: a non-empty AGENTS.override.md in the same directory replaces this file outright -- Codex loads at most one project-doc file per directory (rust-v0.149.1 agents_md.rs).';
const EMPTY_OVERRIDE_NOTE =
	'This AGENTS.override.md exists but is empty, so Codex falls through to AGENTS.md in the same directory.';
const NESTED_CANDIDATE_NOTE =
	'On-demand candidate: loads only when a Codex session cwd is inside this directory. This panel has no live session cwd and treats projectRoot as cwd, so nested files are never part of the actually-injected chain.';

/** Extracts every ATX heading from markdown content, with a deep link each. */
function extractHeadings(content, absPath) {
	if (typeof content !== 'string' || content.length === 0) return [];
	const headings = [];
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const match = HEADING_PATTERN.exec(lines[i]);
		if (!match) continue;
		const line = i + 1;
		headings.push({ text: match[2], level: match[1].length, line, link: vscodeLink(absPath, line) });
	}
	return headings;
}

/** True when any path segment is literally "undefined" -- a known corrupt-path smell. */
function hasUndefinedSegment(absPath) {
	return absPath.split(path.sep).includes('undefined');
}

/** Builds one chain entry by reading `absPath` through the shared read primitive. */
function buildEntry({ layer, absPath, alwaysInjected, scopeDir, note, shadowed }) {
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
		content,
		headings: extractHeadings(content, absPath),
		link: vscodeLink(absPath, 1),
		error: file.error,
		tripsLargeFileWarning: bytes > PROJECT_DOC_MAX_BYTES,
		scopeDir: scopeDir ?? null,
		// Codex-specific additions beyond the Claude row shape: `note` explains a
		// row a Claude reader would not expect (a shadowed sibling, an on-demand
		// candidate); `shadowed` flags a row Codex never actually reads, so a
		// downstream consumer (e.g. the Codex directives scanner) can skip it
		// without string-matching `note`.
		note: note ?? null,
		shadowed: Boolean(shadowed),
	};
}

/**
 * Chooses which project-doc file governs `dir`, in Codex's own order: a
 * non-empty AGENTS.override.md replaces AGENTS.md outright; otherwise
 * AGENTS.md is used if present; otherwise an existing-but-empty override is
 * still the only file in the slot. Returns `null` when neither file exists in
 * `dir` at all AND `alwaysSlot` is false -- a directory with nothing to
 * report. With `alwaysSlot: true` (the user and project-root slots, which are
 * always injected whether or not the file actually exists) this never returns
 * null, defaulting to the plain AGENTS.md path as the honestly-reported slot.
 */
function selectAgentsFile(dir, { alwaysSlot = false } = {}) {
	const overridePath = path.join(dir, 'AGENTS.override.md');
	const plainPath = path.join(dir, 'AGENTS.md');
	const overrideFile = readSourceFile(overridePath);
	const plainFile = readSourceFile(plainPath);
	const overrideNonEmpty = overrideFile.exists && (overrideFile.size ?? 0) > 0;

	if (overrideNonEmpty) {
		return {
			winnerPath: overridePath,
			loser: plainFile.exists ? { path: plainPath, note: REPLACED_NOTE } : null,
		};
	}
	if (plainFile.exists) {
		return {
			winnerPath: plainPath,
			loser: overrideFile.exists ? { path: overridePath, note: EMPTY_OVERRIDE_NOTE } : null,
		};
	}
	if (overrideFile.exists) {
		// Override exists (empty) and plain does not: the empty override is still
		// the only file in the slot, honestly reported with its real (zero) size.
		return { winnerPath: overridePath, loser: null };
	}
	if (alwaysSlot) return { winnerPath: plainPath, loser: null };
	return null;
}

/**
 * Recursively finds every directory (bounded by MAX_NESTED_DEPTH, skipping the
 * usual noise directories) below `dir`. A symlinked directory is never
 * followed -- `Dirent.isDirectory()` is already false for a symlink regardless
 * of what it points to, so no separate check is needed to keep this walk
 * cycle-safe.
 */
function walkNestedDirs(dir, depth, results) {
	if (depth > MAX_NESTED_DEPTH) return;
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
		if (!dirent.isDirectory()) continue;
		if (SKIP_DIR_NAMES.has(dirent.name)) continue;
		const childDir = path.join(dir, dirent.name);
		if (hasUndefinedSegment(childDir)) continue;
		results.push(childDir);
		walkNestedDirs(childDir, depth + 1, results);
	}
}

/**
 * IN-PROCESS read of the chain, entries CARRYING their full file `content`.
 *
 * This is deliberately NOT what `scanCodexMemoryChain()` returns. An AGENTS.md
 * chain is arbitrary repository prose: on this machine the project chain
 * resolves to a CLAUDE.md that contains a live smoke-test credential, and
 * `/api/state` serialises whatever a scanner returns. So the full text is
 * available to in-process consumers that genuinely need to ANALYSE it (the
 * directive classifier, the rule-citation matcher) and never to the HTTP
 * payload.
 *
 * @param {{home: string, projectRoot: string}} options
 * @returns {{entries: object[], truncationNote: string|null}}
 *
 * Top-level shape is an object wrapping `entries`, not a bare array like the
 * Claude counterpart -- `truncationNote` needs somewhere to live, and a
 * property attached directly to an array does not survive `JSON.stringify`.
 * `public/app.js`'s `pickList()`/`asRows()` already accept either a bare array
 * or `{ entries: [...] }`, so this is a compatible extension of the row-shape
 * contract, not a break of it.
 */
export function readCodexMemoryChain({ home, projectRoot }) {
	if (typeof home !== 'string' || home.length === 0 || typeof projectRoot !== 'string' || projectRoot.length === 0) {
		throw new TypeError('scanCodexMemoryChain requires absolute home and projectRoot');
	}

	const paths = resolveCodexPaths({ home, projectRoot });
	const entries = [];

	// (a) User scope: always injected.
	const userSel = selectAgentsFile(paths.user.dir, { alwaysSlot: true });
	const userWinner = buildEntry({ layer: 'user', absPath: userSel.winnerPath, alwaysInjected: true, scopeDir: null });
	entries.push(userWinner);
	if (userSel.loser) {
		entries.push(
			buildEntry({
				layer: 'user',
				absPath: userSel.loser.path,
				alwaysInjected: false,
				scopeDir: null,
				note: userSel.loser.note,
				shadowed: true,
			}),
		);
	}

	// (b) Project root: this panel has no live session cwd, so projectRoot IS
	// the cwd for this inventory -- the documented "root down to cwd" walk
	// collapses to exactly this one directory.
	const rootSel = selectAgentsFile(projectRoot, { alwaysSlot: true });
	const rootWinner = buildEntry({
		layer: 'project',
		absPath: rootSel.winnerPath,
		alwaysInjected: true,
		scopeDir: projectRoot,
	});
	entries.push(rootWinner);
	if (rootSel.loser) {
		entries.push(
			buildEntry({
				layer: 'project',
				absPath: rootSel.loser.path,
				alwaysInjected: false,
				scopeDir: projectRoot,
				note: rootSel.loser.note,
				shadowed: true,
			}),
		);
	}

	// (c) Nested candidates: on-demand only, never part of the injected chain here.
	const nestedDirs = [];
	walkNestedDirs(projectRoot, 1, nestedDirs);
	nestedDirs.sort();
	for (const dir of nestedDirs) {
		const sel = selectAgentsFile(dir, { alwaysSlot: false });
		if (!sel) continue;
		entries.push(
			buildEntry({
				layer: 'project',
				absPath: sel.winnerPath,
				alwaysInjected: false,
				scopeDir: dir,
				note: NESTED_CANDIDATE_NOTE,
			}),
		);
		if (sel.loser) {
			entries.push(
				buildEntry({
					layer: 'project',
					absPath: sel.loser.path,
					alwaysInjected: false,
					scopeDir: dir,
					note: sel.loser.note,
					shadowed: true,
				}),
			);
		}
	}

	// (d) 32 KiB total project-doc budget, root-to-cwd. With projectRoot as cwd
	// the chain is exactly the root winner, so the total IS its byte count.
	let truncationNote = null;
	if (rootWinner.exists && rootWinner.bytes > PROJECT_DOC_MAX_BYTES) {
		truncationNote =
			`Project instructions total ${rootWinner.bytes} bytes at the project root alone, exceeding the ` +
			`${PROJECT_DOC_MAX_BYTES}-byte (32 KiB) project_doc_max_bytes budget; Codex truncates the overflow, ` +
			`decoding lossily as UTF-8, from ${rootWinner.path}.`;
	}

	return { entries, truncationNote };
}

/**
 * The API-facing chain: exactly `readCodexMemoryChain()` minus every row's
 * `content`.
 *
 * The row still carries what a reader of the panel actually needs -- the path,
 * the byte count, the token estimate, every heading with a deep link -- so
 * nothing visible in the UI is lost. What is dropped is the verbatim file body,
 * which is repository prose this panel has no business republishing over HTTP:
 * a credential, a customer name or an internal URL sitting in someone's
 * AGENTS.md would otherwise be served to every reader of `/api/state`. The
 * Claude-side headings-only row shape is the precedent.
 *
 * `readCodexMemoryChain()` remains available for in-process analysis.
 *
 * @param {{home: string, projectRoot: string}} options
 * @returns {{entries: object[], truncationNote: string|null}}
 */
export function scanCodexMemoryChain({ home, projectRoot }) {
	const { entries, truncationNote } = readCodexMemoryChain({ home, projectRoot });
	// `content` is deleted from a COPY of each row: the caller may be holding the
	// in-process entries (rules-scan and directives-scan both read the chain in
	// the same request), and mutating those would strip the text out from under
	// them.
	const stripped = entries.map((entry) => {
		const { content: _content, ...rest } = entry;
		return rest;
	});
	return { entries: stripped, truncationNote };
}

/**
 * Totals over the always-injected slice of the chain only. Mirrors
 * `../memory-chain.mjs`'s `memoryChainTotals()` exactly, including the
 * dedup-by-real-target rule for a symlinked always-injected file.
 *
 * @param {object[]} entries
 */
export function codexMemoryChainTotals(entries) {
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
