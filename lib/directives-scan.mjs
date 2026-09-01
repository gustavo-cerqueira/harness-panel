/**
 * Directive auto-classification: surfaces every imperative directive
 * ("NEVER change any ANTHROPIC_MODEL*", "NEVER create index.ts", ...) buried
 * across the CLAUDE.md memory chain and the shared rules catalog as its own
 * row, instead of leaving safety-critical rules scattered as prose across
 * dozens of files.
 *
 * The scan reuses the same file-discovery shapes as `lib/memory-chain.mjs`
 * and `lib/rules-scan.mjs` (user/project/nested memory + shared rules), but
 * walks them itself rather than calling those modules, because this scanner
 * has its own, stricter symlink policy: a symlinked CLAUDE.md is skipped
 * outright rather than reported as a chain entry, since a directive found
 * through a symlink and through its real target would otherwise be counted
 * twice.
 *
 * CLASSIFICATION DESIGN
 * Every keyword is matched only in two deliberate-emphasis forms: exact
 * ALL-CAPS ("NEVER", "NUNCA") or capitalised-sentence-initial ("Never ...",
 * "Nunca ..."). Ordinary lowercase prose ("we never got around to it") is
 * never matched -- that is what keeps the list free of false positives.
 * Content is split into "blocks" (a bullet or a paragraph, continuation
 * lines joined), then each block into sentences, so a bullet that mixes a
 * NEVER clause and an ALWAYS clause in two sentences surfaces as two
 * directives rather than one blended row.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, vscodeLink } from './source-file.mjs';
import { resolveLayerPaths } from './layers.mjs';
import { redactText } from './mask.mjs';

/** Directive text is trimmed and capped at this many characters. */
export const MAX_DIRECTIVE_CHARS = 400;

/** Directory names the nested walk never descends into. */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build']);

const HEADING_PATTERN = /^(#{1,6})\s+(\S.*?)\s*$/;
const BULLET_START_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+/;
const FENCE_PATTERN = /^\s*```/;
/** ALL-CAPS "NO <THING>" style bans, e.g. "NO MOCK RESPONSES". */
const NO_CAPS_BAN_PATTERN = /\bNO(?:\s+[A-Z]{2,}){1,}\b/;
/** Leading markdown noise (bullet markers, emphasis, blockquote, heading marks). */
const LEADING_MARKDOWN_NOISE = /^[\s*_>#-]+/;

/**
 * Selection priority when several keywords match the same sentence. An
 * explicit prohibition keyword (NEVER, MUST NOT, ...) always outranks an
 * explicit requirement keyword (MUST, ALWAYS, ...), which in turn outranks
 * the loose "NO <WORD>" ban pattern -- a real, deliberate keyword is always a
 * stronger signal than the generic ban, even though the ban is itself tagged
 * severity "prohibition". Explicit caution keywords (SHOULD, PREFER, ...)
 * rank last, below the ban. Ties within the same rank keep the earliest
 * (lowest-index) match in the sentence.
 */
function candidateRank(candidate) {
	if (candidate.isBan) return 2;
	if (candidate.severity === 'prohibition') return 0;
	if (candidate.severity === 'requirement') return 1;
	return 3;
}

/**
 * Keyword table. Multi-word phrases are listed so `MUST NOT` is recognised
 * as its own prohibition distinct from a bare `MUST` requirement; the
 * candidateRank() priority (prohibition > requirement > ban > caution) is
 * what actually keeps a sentence like "You MUST NOT disable this" from also
 * registering a separate MUST requirement on the same text.
 */
const KEYWORD_TABLE = [
	{ word: 'MUST NOT', severity: 'prohibition', language: 'en' },
	{ word: 'DO NOT', severity: 'prohibition', language: 'en' },
	{ word: "DON'T", severity: 'prohibition', language: 'en' },
	{ word: 'NEVER', severity: 'prohibition', language: 'en' },
	{ word: 'NUNCA', severity: 'prohibition', language: 'pt' },
	{ word: 'JAMAIS', severity: 'prohibition', language: 'pt' },
	{ word: 'NÃO', severity: 'prohibition', language: 'pt' },
	{ word: 'MANDATORY', severity: 'requirement', language: 'en' },
	{ word: 'REQUIRED', severity: 'requirement', language: 'en' },
	{ word: 'ALWAYS', severity: 'requirement', language: 'en' },
	{ word: 'MUST', severity: 'requirement', language: 'en' },
	{ word: 'SEMPRE', severity: 'requirement', language: 'pt' },
	{ word: 'OBRIGATÓRIO', severity: 'requirement', language: 'pt' },
	{ word: 'DEVE', severity: 'requirement', language: 'pt' },
	{ word: 'SHOULD', severity: 'caution', language: 'en' },
	{ word: 'PREFER', severity: 'caution', language: 'en' },
	{ word: 'AVOID', severity: 'caution', language: 'en' },
	{ word: 'EVITE', severity: 'caution', language: 'pt' },
	{ word: 'PREFIRA', severity: 'caution', language: 'pt' },
];

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEYWORD_PATTERNS = KEYWORD_TABLE.map((def) => ({
	...def,
	allCapsRegex: new RegExp(`\\b${escapeRegExp(def.word)}\\b`),
	titleCase: def.word.charAt(0) + def.word.slice(1).toLowerCase(),
}));

/** True when any path segment is literally "undefined" -- a known corrupt-path smell. */
function hasUndefinedSegment(absPath) {
	return absPath.split(path.sep).includes('undefined');
}

/** Replaces inline code spans with equal-length blanks so keywords written only inside `code` never match. */
function maskInlineCode(text) {
	return text.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

/** A row of table-separator syntax (`| --- | --- |`, `---`) carries no directive content. */
function isTableSeparatorRow(line) {
	const trimmed = line.trim();
	if (trimmed.length === 0 || !trimmed.includes('-')) return false;
	return /^[|:\-\s]+$/.test(trimmed);
}

/**
 * Finds the highest-priority directive keyword in one sentence, or null.
 * A keyword counts only as exact ALL-CAPS anywhere in the sentence, or as
 * its Title-case form at the very start of the sentence (after stripping
 * leading markdown noise) -- the two deliberate-emphasis forms the authors
 * actually use. Matching happens against a code-span-masked copy so a
 * keyword written only inside `backticks` never counts.
 */
function findDirectiveMatch(sentence) {
	const masked = maskInlineCode(sentence);
	const stripped = masked.replace(LEADING_MARKDOWN_NOISE, '');
	const leadingStripLen = masked.length - stripped.length;
	const candidates = [];

	for (const def of KEYWORD_PATTERNS) {
		const allCapsMatch = def.allCapsRegex.exec(masked);
		if (allCapsMatch) {
			candidates.push({
				keyword: allCapsMatch[0],
				severity: def.severity,
				language: def.language,
				index: allCapsMatch.index,
			});
			continue;
		}
		if (stripped.startsWith(def.titleCase)) {
			const next = stripped.charAt(def.titleCase.length);
			const isWordBoundary = next === '' || !/[A-Za-zÀ-ÿ0-9]/.test(next);
			if (isWordBoundary) {
				candidates.push({
					keyword: def.titleCase,
					severity: def.severity,
					language: def.language,
					index: leadingStripLen,
				});
			}
		}
	}

	const banMatch = NO_CAPS_BAN_PATTERN.exec(masked);
	if (banMatch) {
		candidates.push({
			keyword: banMatch[0],
			severity: 'prohibition',
			language: 'en',
			index: banMatch.index,
			isBan: true,
		});
	}

	if (candidates.length === 0) return null;

	candidates.sort((a, b) => candidateRank(a) - candidateRank(b) || a.index - b.index);
	return candidates[0];
}

/** Best-effort sentence split on terminal punctuation followed by whitespace. */
function splitIntoSentences(text) {
	return text
		.split(/(?<=[.!?])\s+(?=[A-ZÀ-Þ0-9"'`*])/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * Groups markdown content into blocks: a bullet/paragraph plus any
 * continuation lines, so a directive that wraps across physical lines is
 * joined into one text before sentence-splitting. Fenced code regions and
 * table-separator rows are excluded from every block; each block records
 * the nearest preceding ATX heading.
 *
 * Two content shapes are never allowed to merge into a bigger block, each
 * becoming its own single-line block instead:
 *  - A markdown table content row (trimmed form starts with `|`; separator
 *    rows like `| --- |` are still skipped entirely, same as before). Without
 *    this, consecutive table rows -- none of which look like a bullet -- fold
 *    into one continuation block, producing one giant, capped, mis-anchored
 *    row for the whole table instead of one row per table row.
 *  - An ATX heading line. Its text is run through the same extraction as any
 *    other block, anchored at the heading's own line, so a directive stated
 *    as a heading (e.g. "### NEVER create index.ts files for barrel exports")
 *    is not silently dropped just because it never had a chance to reach
 *    extractDirectives() before. currentHeading is still updated first, so
 *    every later block in the section keeps pointing at this heading.
 */
function buildBlocks(content) {
	const lines = content.split('\n');
	const blocks = [];
	let currentBlock = null;
	let currentHeading = null;
	let insideFence = false;

	const closeBlock = () => {
		if (currentBlock) blocks.push(currentBlock);
		currentBlock = null;
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const lineNumber = i + 1;

		if (FENCE_PATTERN.test(line)) {
			insideFence = !insideFence;
			closeBlock();
			continue;
		}
		if (insideFence) continue;
		if (isTableSeparatorRow(line)) {
			closeBlock();
			continue;
		}

		const trimmed = line.trim();
		if (trimmed.length === 0) {
			closeBlock();
			continue;
		}

		if (trimmed.startsWith('|')) {
			closeBlock();
			blocks.push({ startLine: lineNumber, texts: [trimmed], heading: currentHeading });
			continue;
		}

		const headingMatch = HEADING_PATTERN.exec(line);
		if (headingMatch) {
			currentHeading = headingMatch[2];
			closeBlock();
			blocks.push({ startLine: lineNumber, texts: [currentHeading], heading: currentHeading });
			continue;
		}

		if (BULLET_START_PATTERN.test(line) || currentBlock === null) {
			closeBlock();
			currentBlock = { startLine: lineNumber, texts: [trimmed], heading: currentHeading };
		} else {
			currentBlock.texts.push(trimmed);
		}
	}
	closeBlock();
	return blocks;
}

/** Extracts every directive found in `content`, without source metadata (added by the caller). */
function extractDirectives(content) {
	if (typeof content !== 'string' || content.length === 0) return [];
	const blocks = buildBlocks(content);
	const found = [];

	for (const block of blocks) {
		const blockText = block.texts.join(' ');
		for (const sentence of splitIntoSentences(blockText)) {
			const match = findDirectiveMatch(sentence);
			if (!match) continue;
			const text = sentence.length > MAX_DIRECTIVE_CHARS ? sentence.slice(0, MAX_DIRECTIVE_CHARS) : sentence;
			found.push({
				text: redactText(text),
				severity: match.severity,
				keyword: match.keyword,
				language: match.language,
				line: block.startLine,
				heading: block.heading,
			});
		}
	}
	return found;
}

/**
 * Recursively finds every file literally named `CLAUDE.md` under `dir`,
 * skipping the usual noise directories and `exclude`d paths. Unlike
 * `lib/memory-chain.mjs`, a symlink -- file or directory -- is never
 * followed and never reported: a directive read through a symlink and
 * through its real target would double-count the same rule.
 */
function walkForNestedMemoryFiles(dir, exclude, results) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // unreadable directory: best-effort discovery, skip rather than abort siblings
	}

	for (const dirent of entries) {
		const abs = path.join(dir, dirent.name);
		if (hasUndefinedSegment(abs)) continue;
		if (dirent.isSymbolicLink()) continue; // detect and skip symlinks entirely

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
 * @returns {object} see module-level shape in the caller's brief: directives, totals, scanned, error
 */
export function scanDirectives({ home, projectRoot }) {
	if (typeof home !== 'string' || home.length === 0 || typeof projectRoot !== 'string' || projectRoot.length === 0) {
		return {
			directives: [],
			totals: emptyTotals(),
			scanned: [],
			error: 'scanDirectives requires a string home and projectRoot',
		};
	}

	const paths = resolveLayerPaths({ home, projectRoot });
	const scanned = [];
	const directives = [];
	const seen = new Set();

	function admit(absPath, sourceKind, alwaysLoaded) {
		const file = readSourceFile(absPath);
		scanned.push({ path: absPath, kind: sourceKind, alwaysLoaded, bytes: file.size ?? 0, error: file.error });
		if (!file.readable || file.content == null) return;

		for (const found of extractDirectives(file.content)) {
			const key = `${absPath} ${found.line} ${found.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			directives.push({
				...found,
				sourcePath: absPath,
				link: vscodeLink(absPath, found.line),
				sourceKind,
				alwaysLoaded,
			});
		}
	}

	// User + project memory: always injected.
	const userMemoryPath = paths.user.memory;
	admit(userMemoryPath, 'user-memory', true);

	const projectMemoryPath = paths.project.memory;
	admit(projectMemoryPath, 'project-memory', true);

	// Nested memory: loaded on demand, walked below the project root. The
	// root AGENTS.md symlink is never a candidate here -- it is named
	// AGENTS.md, not CLAUDE.md, so the "**/CLAUDE.md" walk never sees it and
	// the project memory it aliases is never duplicated.
	const exclude = new Set([userMemoryPath, projectMemoryPath]);
	const nestedPaths = [];
	walkForNestedMemoryFiles(projectRoot, exclude, nestedPaths);
	nestedPaths.sort();
	for (const absPath of nestedPaths) {
		admit(absPath, 'nested-memory', false);
	}

	// Shared rules catalog: loaded on demand.
	const rulesDir = paths.project.rulesDir;
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
		admit(path.join(rulesDir, name), 'rule', false);
	}

	return { directives, totals: computeTotals(directives), scanned, error: null };
}

/**
 * Additive export for `lib/codex/directives-scan.mjs`. The Codex scanner walks
 * a completely different file tree (the AGENTS.md chain, not CLAUDE.md), so it
 * cannot reuse `scanDirectives()` itself -- but the actual classification work
 * (the ALL-CAPS/sentence-initial keyword table, code-fence and code-span
 * masking, block/sentence splitting, MAX_DIRECTIVE_CHARS capping) is
 * harness-agnostic markdown analysis. Exporting it here means a fix to the
 * classifier (e.g. a missed keyword pattern) is inherited by both harnesses
 * from one place, instead of drifting between two copies. No existing export
 * changes shape; this is a pure addition.
 */
export { extractDirectives };
