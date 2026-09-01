/**
 * The shared rules catalog: `<projectRoot>/.ai-config/shared/rules/*.md`.
 *
 * `mandatory` is derived, not guessed: the project CLAUDE.md carries a
 * blanket sentence ("All rules in `.ai-config/shared/rules/` are mandatory")
 * and this module actually greps that file for it before calling any rule
 * mandatory. A rule additionally named by filename anywhere in that same
 * CLAUDE.md gets `citedExplicitly: true` and a `referencedBy` entry per
 * citation line; a rule the blanket statement covers but nobody named
 * individually stays mandatory with `citedExplicitly: false` and an empty
 * `referencedBy` -- the two are never conflated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, readSourceFile, vscodeLink } from './source-file.mjs';

const TITLE_PATTERN = /^(#{1,2})\s+(\S.*?)\s*$/;

/**
 * Tolerant match for the blanket "all rules here are mandatory" sentence.
 * Accepts every/all + file(s)/rule(s) + in/under + either the literal rules
 * path or a "shared rules" phrase + is/are + mandatory, so both the historic
 * wording ("All rules in `.ai-config/shared/rules/` are mandatory") and the
 * live CLAUDE.md wording ("Every file in `.ai-config/shared/rules/` is
 * mandatory") match, along with reasonable variants in between.
 */
const BLANKET_MANDATORY_PATTERN =
	/\b(?:every|all)\s+(?:files?|rules?)\s+(?:in|under)\s+(?:`?\.ai-config\/shared\/rules\/?`?|(?:the\s+)?shared\s+rules(?:\s+(?:directory|folder|catalog))?)\s+(?:is|are)\s+mandatory/i;

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

/** Every line in `claudeMdContent` that literally names `ruleFileName`. */
function findCitations(claudeMdContent, claudeMdPath, ruleFileName) {
	if (typeof claudeMdContent !== 'string' || claudeMdContent.length === 0) return [];
	const citations = [];
	const lines = claudeMdContent.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		if (lines[i].includes(ruleFileName)) {
			const line = i + 1;
			citations.push({ file: claudeMdPath, line, link: vscodeLink(claudeMdPath, line) });
		}
	}
	return citations;
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

function buildRuleEntry({ name, rulesDir, claudeMdPath, claudeMdContent, blanketMandatory }) {
	const absPath = path.join(rulesDir, name);
	const file = readSourceFile(absPath);
	const bytes = file.size ?? 0;
	const referencedBy = findCitations(claudeMdContent, claudeMdPath, name);

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
}

/**
 * @param {{projectRoot: string}} options
 * @returns {{rules: object[], error: string|null, path: string}}
 */
export function scanRules({ projectRoot }) {
	if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
		throw new TypeError('scanRules requires an absolute projectRoot');
	}

	const rulesDir = path.join(projectRoot, '.ai-config', 'shared', 'rules');
	const claudeMdPath = path.join(projectRoot, '.claude', 'CLAUDE.md');

	let dirEntries;
	try {
		dirEntries = fs.readdirSync(rulesDir, { withFileTypes: true });
	} catch (error) {
		return { rules: [], error: String(error?.message || error), path: rulesDir };
	}

	const claudeMd = readSourceFile(claudeMdPath);
	const claudeMdContent = claudeMd.readable ? claudeMd.content : '';
	const blanketMandatory = BLANKET_MANDATORY_PATTERN.test(claudeMdContent);

	const rules = dirEntries
		.filter((entry) => entry.name.endsWith('.md') && isMdFileEntry(entry, rulesDir))
		.map((entry) => entry.name)
		.sort()
		.map((name) => buildRuleEntry({ name, rulesDir, claudeMdPath, claudeMdContent, blanketMandatory }));

	return { rules, error: null, path: rulesDir };
}

/**
 * Additive exports for `lib/codex/rules-scan.mjs`. Codex has no `.claude/CLAUDE.md`
 * to grep for the blanket "all rules are mandatory" sentence or a rule's filename
 * citation -- it has the AGENTS.md chain instead, over potentially more than one
 * citing document (user AGENTS.md and the repo AGENTS.md, both read as their own
 * files). These wrappers reference the existing private `BLANKET_MANDATORY_PATTERN`
 * and `findCitations` WITHOUT changing their declarations, so a future fix to
 * either (e.g. widening the blanket-statement wording the pattern matches) is
 * inherited automatically by the Codex scanner. Pure additions; no existing
 * export changes shape.
 */
export function isBlanketRulesMandatory(content) {
	return BLANKET_MANDATORY_PATTERN.test(typeof content === 'string' ? content : '');
}

export function findRuleCitations(content, sourcePath, ruleFileName) {
	return findCitations(content, sourcePath, ruleFileName);
}
