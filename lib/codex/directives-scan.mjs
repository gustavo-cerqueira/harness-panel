/**
 * Directive auto-classification for the Codex harness: every imperative
 * directive ("NEVER commit auth.json", "MUST call enforceContributorOwnership")
 * buried across the AGENTS.md chain and the shared rules catalog, surfaced as
 * its own row. Codex counterpart of `../directives-scan.mjs`.
 *
 * This scanner does NOT re-implement the classifier. The keyword table,
 * ALL-CAPS/sentence-initial matching rules, code-fence and inline-code-span
 * masking, and block/sentence splitting are pure markdown-text analysis with
 * nothing Codex-specific about them, so `extractDirectives()` is imported from
 * `../directives-scan.mjs` (an additive export added there for this purpose --
 * the Claude module's own exports and tests are unchanged). A fix to that
 * classifier is inherited by both harnesses automatically.
 *
 * What IS Codex-specific is which files get fed to it: instead of Claude's
 * CLAUDE.md chain, this walks `readCodexMemoryChain()`'s AGENTS.md chain -- the
 * in-process read that still carries each file's text, because the API-facing
 * `scanCodexMemoryChain()` deliberately strips it (see
 * `./memory-chain.mjs` for the discovery rule, sourced from Codex 0.149.1
 * `agents_md.rs` semantics as reported by Codex on 2026-08-26) plus the same
 * `.ai-config/shared/rules/*.md` catalog Claude reads.
 *
 * HONEST LIMITS:
 *   - A memory-chain entry marked `shadowed` (an AGENTS.md replaced by a
 *     sibling AGENTS.override.md, or an empty override Codex skips) is
 *     excluded from scanning entirely. Its directives are real text on disk,
 *     but Codex never injects that file in this directory, so reporting them
 *     as live guidance would be a false claim about what the agent actually
 *     reads -- the same reasoning `../directives-scan.mjs` uses to skip a
 *     symlinked nested CLAUDE.md.
 *   - `sourceKind` reuses Claude's vocabulary (`user-memory`, `project-memory`,
 *     `nested-memory`, `rule`) rather than inventing Codex-specific labels, so
 *     `totals.byKind` has the same shape on both harnesses even though the
 *     underlying file names differ (AGENTS.md vs CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, vscodeLink } from '../source-file.mjs';
import { extractDirectives } from '../directives-scan.mjs';
import { readCodexMemoryChain } from './memory-chain.mjs';
import { redactText } from '../mask.mjs';

function emptyTotals() {
	return {
		total: 0,
		byKind: { 'user-memory': 0, 'project-memory': 0, 'nested-memory': 0, rule: 0 },
		bySeverity: { prohibition: 0, requirement: 0, caution: 0 },
		alwaysLoaded: 0,
		onDemand: 0,
	};
}

function computeTotals(directives) {
	const totals = emptyTotals();
	totals.total = directives.length;
	for (const directive of directives) {
		totals.byKind[directive.sourceKind] = (totals.byKind[directive.sourceKind] ?? 0) + 1;
		totals.bySeverity[directive.severity] = (totals.bySeverity[directive.severity] ?? 0) + 1;
		if (directive.alwaysLoaded) totals.alwaysLoaded += 1;
		else totals.onDemand += 1;
	}
	return totals;
}

/**
 * @param {{home: string, projectRoot: string}} options
 * @returns {object} same shape as `scanDirectives()`: directives, totals, scanned, error
 */
export function scanCodexDirectives({ home, projectRoot }) {
	if (typeof home !== 'string' || home.length === 0 || typeof projectRoot !== 'string' || projectRoot.length === 0) {
		return {
			directives: [],
			totals: emptyTotals(),
			scanned: [],
			error: 'scanCodexDirectives requires a string home and projectRoot',
		};
	}

	const scanned = [];
	const directives = [];
	const seen = new Set();

	function admit(absPath, content, sourceKind, alwaysLoaded, error, bytes) {
		scanned.push({ path: absPath, kind: sourceKind, alwaysLoaded, bytes: bytes ?? 0, error: error ?? null });
		if (error || typeof content !== 'string') return;

		for (const found of extractDirectives(content)) {
			const key = `${absPath} ${found.line} ${found.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			directives.push({
				...found,
				// A directive is a sentence lifted verbatim out of an instruction
				// file, and an instruction file is free-form prose that may name a
				// credential ("NEVER change the smoke-test password <value>"). Every
				// emitted string goes through `redactText` for the same reason the
				// memory chain no longer ships file bodies: this row is serialised
				// into `/api/state`.
				text: redactText(found.text),
				heading: found.heading == null ? null : redactText(found.heading),
				sourcePath: absPath,
				link: vscodeLink(absPath, found.line),
				sourceKind,
				alwaysLoaded,
			});
		}
	}

	let chain;
	try {
		chain = readCodexMemoryChain({ home, projectRoot });
	} catch (error) {
		return { directives: [], totals: emptyTotals(), scanned: [], error: String(error?.message || error) };
	}

	for (const entry of chain.entries) {
		// Never injected in this directory -- see the HONEST LIMITS note above.
		if (entry.shadowed) continue;
		const sourceKind =
			entry.layer === 'user' ? 'user-memory' : entry.alwaysInjected ? 'project-memory' : 'nested-memory';
		admit(entry.path, entry.content, sourceKind, entry.alwaysInjected, entry.error, entry.bytes);
	}

	// Shared rules catalog: loaded on demand, same directory Claude's scanner reads.
	const rulesDir = path.join(projectRoot, '.ai-config', 'shared', 'rules');
	let ruleEntries;
	try {
		ruleEntries = fs.readdirSync(rulesDir, { withFileTypes: true });
	} catch (error) {
		scanned.push({
			path: rulesDir,
			kind: 'rule',
			alwaysLoaded: false,
			bytes: 0,
			error: String(error?.message || error),
		});
		ruleEntries = [];
	}
	const ruleFileNames = ruleEntries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
		.map((entry) => entry.name)
		.sort();
	for (const name of ruleFileNames) {
		const absPath = path.join(rulesDir, name);
		const file = readSourceFile(absPath);
		admit(absPath, file.content, 'rule', false, file.error, file.size);
	}

	return { directives, totals: computeTotals(directives), scanned, error: null };
}
