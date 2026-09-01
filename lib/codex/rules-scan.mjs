/**
 * The shared rules catalog, read as Codex sees it: `<projectRoot>/.ai-config/
 * shared/rules/*.md`. Codex counterpart of `../rules-scan.mjs`.
 *
 * `mandatory` is derived the same way the Claude scanner derives it -- by
 * actually finding the blanket "every file in `.ai-config/shared/rules/` is
 * mandatory" sentence in a real citing document -- but Codex has no single
 * `.claude/CLAUDE.md` to grep. Its citing documents are the files Codex itself
 * injects: the always-injected, non-shadowed entries of `readCodexMemoryChain()`
 * (user AGENTS.md and the repo AGENTS.md; see `./memory-chain.mjs`, sourced
 * from Codex 0.149.1 `agents_md.rs` semantics as reported by Codex on
 * 2026-08-26). Both the blanket-mandatory check and the per-rule filename
 * citation search go through `../rules-scan.mjs`'s additive exports
 * (`isBlanketRulesMandatory`, `findRuleCitations`) rather than being
 * reimplemented here, so a fix to either (e.g. widening the blanket-statement
 * wording the pattern matches) is inherited automatically.
 *
 * HONEST LIMITS:
 *   - `referencedBy[].file` is always the path Codex itself reads -- the repo
 *     AGENTS.md symlink, never the `.claude/CLAUDE.md` it resolves to -- because
 *     the memory-chain entry's `.path` is the symlink path, not its
 *     `symlinkTarget`, and citation search runs against that entry's `.content`
 *     directly rather than re-reading through the resolved target.
 *   - A citing document the memory chain marks `shadowed` (replaced by a
 *     sibling AGENTS.override.md, or itself an empty override Codex skips) is
 *     excluded, for the same reason `./directives-scan.mjs` excludes it: Codex
 *     never actually injects that text, so a citation found only there would
 *     misreport a rule as explicitly named when it is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, readSourceFile, vscodeLink } from '../source-file.mjs';
import { findRuleCitations, isBlanketRulesMandatory } from '../rules-scan.mjs';
import { resolveCodexPaths } from './layers.mjs';
import { readCodexMemoryChain } from './memory-chain.mjs';

const TITLE_PATTERN = /^(#{1,2})\s+(\S.*?)\s*$/;

/** First H1/H2 heading text, or the filename when the file has none. */
function extractTitle(content, fallbackName) {
	if (typeof content === 'string') {
		for (const line of content.split('\n')) {
			const match = TITLE_PATTERN.exec(line);
			if (match) return match[2];
		}
	}
	return fallbackName;
}

/**
 * Whether a directory entry should be treated as a rule file candidate,
 * following symlinks so a symlinked rule (e.g. an alias into another doc) is
 * still picked up -- unlike a plain directory named `*.md`, which must NOT be
 * treated as a rule. A broken symlink is still a candidate: it is named like
 * a rule, and `readSourceFile` will surface its real error rather than have
 * this filter silently drop it.
 */
function isMdFileEntry(entry, rulesDir) {
	if (entry.isFile()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return fs.statSync(path.join(rulesDir, entry.name)).isFile();
	} catch {
		return true; // broken symlink: let readSourceFile report the real error
	}
}

/**
 * @param {{home: string, projectRoot: string}} options
 * @returns {{rules: object[], error: string|null, path: string}}
 */
export function scanCodexRules({ home, projectRoot }) {
	if (typeof home !== 'string' || home.length === 0 || typeof projectRoot !== 'string' || projectRoot.length === 0) {
		throw new TypeError('scanCodexRules requires absolute home and projectRoot');
	}

	const paths = resolveCodexPaths({ home, projectRoot });
	const rulesDir = paths.project.rulesDir;

	let dirEntries;
	try {
		dirEntries = fs.readdirSync(rulesDir, { withFileTypes: true });
	} catch (error) {
		return { rules: [], error: String(error?.message || error), path: rulesDir };
	}

	// Citing documents: exactly the files Codex actually injects -- never a
	// shadowed sibling, never a resolved symlink target.
	let citingDocs = [];
	try {
		const chain = readCodexMemoryChain({ home, projectRoot }).entries;
		citingDocs = chain
			.filter((entry) => entry.alwaysInjected && !entry.shadowed)
			.map((entry) => ({ path: entry.path, content: entry.content }));
	} catch {
		citingDocs = [];
	}

	const blanketMandatory = citingDocs.some((doc) => isBlanketRulesMandatory(doc.content));

	const rules = dirEntries
		.filter((entry) => entry.name.endsWith('.md') && isMdFileEntry(entry, rulesDir))
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const absPath = path.join(rulesDir, name);
			const file = readSourceFile(absPath);
			const bytes = file.size ?? 0;
			const referencedBy = citingDocs.flatMap((doc) => findRuleCitations(doc.content, doc.path, name));

			return {
				name,
				path: absPath,
				line: 1,
				link: vscodeLink(absPath, 1),
				bytes,
				estimatedTokens: estimateTokens(file.content ?? ''),
				title: extractTitle(file.content, name),
				mandatory: blanketMandatory,
				referencedBy,
				citedExplicitly: referencedBy.length > 0,
				error: file.error,
			};
		});

	return { rules, error: null, path: rulesDir };
}
