import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_DIRECTIVE_CHARS, scanDirectives } from '../lib/directives-scan.mjs';

// Test scaffolding writes to a temp dir only. The library under test never
// writes; that is asserted separately by the read-only grep in the validation
// suite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-directives-'));

/** A fresh {home, projectRoot} pair with the standard skeleton dirs in place. */
function makeFixture(name) {
	const home = path.join(TMP, name, 'home');
	const projectRoot = path.join(TMP, name, 'project');
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, '.ai-config', 'shared', 'rules'), { recursive: true });
	// Harmless, directive-free content so fixtures that don't care about one
	// side of the scan don't pollute assertions with unrelated matches.
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# User memory\nsome ordinary preferences\n');
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), '# Project memory\nplaceholder\n');
	return { home, projectRoot };
}

function writeProjectMemory(projectRoot, content) {
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), content);
}

test('an ALL-CAPS NEVER is captured as a prohibition in English, with a working link', () => {
	const { home, projectRoot } = makeFixture('all-caps-never');
	writeProjectMemory(projectRoot, '# Rules\n\n- NEVER delete the audit log.\n');

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'NEVER' && d.text.includes('delete the audit log'));

	assert.ok(hit, 'expected a NEVER directive to be found');
	assert.equal(hit.severity, 'prohibition');
	assert.equal(hit.language, 'en');
	assert.equal(hit.sourceKind, 'project-memory');
	assert.equal(hit.alwaysLoaded, true);
	assert.equal(hit.line, 3);
	assert.equal(hit.sourcePath, path.join(projectRoot, '.claude', 'CLAUDE.md'));
	assert.equal(hit.link, `vscode://file${hit.sourcePath}:3`);
});

test('lowercase "never" inside ordinary prose is never treated as a directive', () => {
	const { home, projectRoot } = makeFixture('lowercase-never');
	writeProjectMemory(
		projectRoot,
		'# Notes\n\nWe never really finished wiring up that migration, so keep an eye on it.\n',
	);

	const result = scanDirectives({ home, projectRoot });
	const falsePositive = result.directives.find((d) => d.text.includes('never really finished'));

	assert.equal(falsePositive, undefined);
});

test('a capitalised sentence-initial "Never" is still captured, unlike mid-sentence lowercase "never"', () => {
	const { home, projectRoot } = makeFixture('sentence-initial-never');
	writeProjectMemory(
		projectRoot,
		[
			'# Notes',
			'',
			'- **Spec Citation**: ALWAYS name the source file first. Never cite a task number without it.',
			'',
		].join('\n'),
	);

	const result = scanDirectives({ home, projectRoot });
	const never = result.directives.find((d) => d.text.startsWith('Never cite a task number'));
	const always = result.directives.find((d) => d.keyword === 'ALWAYS');

	assert.ok(never, 'expected sentence-initial Never to be captured');
	assert.equal(never.severity, 'prohibition');
	assert.equal(never.keyword, 'Never');
	assert.ok(always, 'expected the ALL-CAPS ALWAYS to be captured too');
	assert.equal(always.severity, 'requirement');
});

test('a directive-looking line inside a fenced code block is skipped entirely', () => {
	const { home, projectRoot } = makeFixture('fenced-code');
	writeProjectMemory(
		projectRoot,
		[
			'# Examples',
			'',
			'```ts',
			'// NEVER do this in real code, it is just illustrating the anti-pattern',
			'const x = 1;',
			'```',
			'',
			'- NEVER do this for real, outside any code fence.',
			'',
		].join('\n'),
	);

	const result = scanDirectives({ home, projectRoot });
	const fromFence = result.directives.find((d) => d.text.includes('illustrating the anti-pattern'));
	const fromProse = result.directives.find((d) => d.text.includes('outside any code fence'));

	assert.equal(fromFence, undefined, 'a directive inside a fenced code block must not be admitted');
	assert.ok(fromProse, 'the live directive outside the fence must still be found');
});

test('a directive written only inside an inline code span is not matched from the span', () => {
	const { home, projectRoot } = makeFixture('inline-code-span');
	writeProjectMemory(
		projectRoot,
		'# Notes\n\n- The env flag is named `NEVER_DISABLE_AUDIT`, purely informational here.\n',
	);

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.text.includes('NEVER_DISABLE_AUDIT'));

	assert.equal(hit, undefined, 'a keyword that only exists inside a code span must not count as a directive');
});

test('a Portuguese NUNCA is classified as a prohibition with language "pt"', () => {
	const { home, projectRoot } = makeFixture('portuguese-nunca');
	writeProjectMemory(projectRoot, '# Regras\n\n- NUNCA apague os logs de auditoria sem aprovação.\n');

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'NUNCA');

	assert.ok(hit, 'expected a NUNCA directive to be found');
	assert.equal(hit.severity, 'prohibition');
	assert.equal(hit.language, 'pt');
});

test('lowercase Portuguese prose ("não", "deve") is not treated as a directive', () => {
	const { home, projectRoot } = makeFixture('portuguese-lowercase');
	writeProjectMemory(
		projectRoot,
		'# Notas\n\nEste módulo não deve ser confundido com o antigo, mas isso é só um comentário.\n',
	);

	const result = scanDirectives({ home, projectRoot });
	const falsePositive = result.directives.find((d) => d.text.includes('não deve ser confundido'));

	assert.equal(falsePositive, undefined);
});

test('a bullet spanning multiple physical lines is joined into one directive text', () => {
	const { home, projectRoot } = makeFixture('multiline-bullet');
	writeProjectMemory(
		projectRoot,
		[
			'# Section',
			'',
			'- NEVER perform this risky operation across',
			'  multiple physical lines in the same file.',
			'',
		].join('\n'),
	);

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'NEVER');

	assert.ok(hit, 'expected the joined directive to be found');
	assert.ok(hit.text.includes('perform this risky operation across'));
	assert.ok(hit.text.includes('multiple physical lines in the same file.'));
	// Anchored at the line the bullet starts on, not the continuation line.
	assert.equal(hit.line, 3);
});

test('the nearest preceding markdown heading is attached to each directive', () => {
	const { home, projectRoot } = makeFixture('nearest-heading');
	writeProjectMemory(
		projectRoot,
		[
			'# Top',
			'',
			'## Safety Rules',
			'',
			'- NEVER skip the safety check.',
			'',
			'## Other Section',
			'',
			'- ALWAYS log the outcome.',
			'',
		].join('\n'),
	);

	const result = scanDirectives({ home, projectRoot });
	const never = result.directives.find((d) => d.keyword === 'NEVER');
	const always = result.directives.find((d) => d.keyword === 'ALWAYS');

	assert.equal(never.heading, 'Safety Rules');
	assert.equal(always.heading, 'Other Section');
});

test('a directive with no preceding heading carries heading: null', () => {
	const { home, projectRoot } = makeFixture('no-heading');
	writeProjectMemory(projectRoot, '- NEVER start here without any heading above.\n');

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'NEVER');

	assert.equal(hit.heading, null);
});

test('a symlinked nested CLAUDE.md is skipped and never double-counts the real file', () => {
	const { home, projectRoot } = makeFixture('symlink-skip');
	const realDir = path.join(projectRoot, 'nested-real');
	const linkDir = path.join(projectRoot, 'nested-symlink');
	fs.mkdirSync(realDir, { recursive: true });
	fs.mkdirSync(linkDir, { recursive: true });
	const realFile = path.join(realDir, 'CLAUDE.md');
	fs.writeFileSync(realFile, '- NEVER touch the nested config directly.\n');
	fs.symlinkSync(realFile, path.join(linkDir, 'CLAUDE.md'));

	const result = scanDirectives({ home, projectRoot });
	const nestedHits = result.directives.filter((d) => d.sourceKind === 'nested-memory');

	assert.equal(nestedHits.length, 1, 'the symlinked copy must not be scanned or double-counted');
	assert.equal(nestedHits[0].sourcePath, realFile);
	assert.ok(!result.scanned.some((s) => s.path === path.join(linkDir, 'CLAUDE.md')));
});

test('a missing user memory file is recorded in scanned with its real error, never silently dropped', () => {
	const { home, projectRoot } = makeFixture('missing-user-memory');
	fs.rmSync(path.join(home, '.claude', 'CLAUDE.md'), { force: true });

	const result = scanDirectives({ home, projectRoot });
	const entry = result.scanned.find((s) => s.kind === 'user-memory');

	assert.ok(entry, 'expected a scanned entry for the user memory file even though it is missing');
	assert.ok(entry.error && /ENOENT/.test(entry.error));
	assert.equal(result.error, null, 'a single missing source file must not fail the whole scan');
});

test('a missing shared rules directory is recorded honestly rather than thrown', () => {
	const { home, projectRoot } = makeFixture('missing-rules-dir');
	fs.rmSync(path.join(projectRoot, '.ai-config', 'shared', 'rules'), { recursive: true, force: true });

	assert.doesNotThrow(() => scanDirectives({ home, projectRoot }));
	const result = scanDirectives({ home, projectRoot });
	const ruleEntry = result.scanned.find((s) => s.kind === 'rule');

	assert.ok(ruleEntry, 'expected the missing rules directory to still surface a scanned entry');
	assert.ok(ruleEntry.error && ruleEntry.error.length > 0);
});

test('rule files are scanned with sourceKind "rule" and alwaysLoaded false', () => {
	const { home, projectRoot } = makeFixture('rule-file');
	fs.writeFileSync(
		path.join(projectRoot, '.ai-config', 'shared', 'rules', 'some-rule.md'),
		'# Some Rule\n\n- SHOULD prefer explicit config over defaults.\n',
	);

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'SHOULD');

	assert.ok(hit);
	assert.equal(hit.severity, 'caution');
	assert.equal(hit.sourceKind, 'rule');
	assert.equal(hit.alwaysLoaded, false);
});

test('"DO NOT" and "MUST NOT" are matched as whole-phrase ALL-CAPS prohibitions', () => {
	const { home, projectRoot } = makeFixture('multi-word-prohibitions');
	writeProjectMemory(
		projectRoot,
		['# Rules', '', '- DO NOT bypass the review gate.', '- You MUST NOT disable the throttle guard.', ''].join('\n'),
	);

	const result = scanDirectives({ home, projectRoot });
	const doNot = result.directives.find((d) => d.keyword === 'DO NOT');
	const mustNot = result.directives.find((d) => d.keyword === 'MUST NOT');

	assert.ok(doNot);
	assert.equal(doNot.severity, 'prohibition');
	assert.ok(mustNot);
	assert.equal(mustNot.severity, 'prohibition');
	// "MUST NOT" must win over a separately-registered "MUST" requirement match
	// on the very same sentence -- only one directive row per sentence.
	assert.equal(result.directives.filter((d) => d.text.includes('disable the throttle guard')).length, 1);
});

test('an ALL-CAPS "NO <THING>" style ban is matched as a prohibition', () => {
	const { home, projectRoot } = makeFixture('no-caps-ban');
	writeProjectMemory(projectRoot, '# Rules\n\nNO MOCK RESPONSES are allowed in this module.\n');

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.severity === 'prohibition' && d.text.includes('MOCK RESPONSES'));

	assert.ok(hit);
	assert.equal(hit.language, 'en');
});

test('a markdown table separator row is never treated as directive content', () => {
	const { home, projectRoot } = makeFixture('table-separator');
	writeProjectMemory(projectRoot, ['# Table', '', '| A | B |', '| --- | --- |', '| NEVER | ALWAYS |', ''].join('\n'));

	// The separator row itself must not blow up the scan or produce a phantom
	// directive; the two ALL-CAPS table cells are still ordinary matched text,
	// but the separator row contributes nothing.
	assert.doesNotThrow(() => scanDirectives({ home, projectRoot }));
});

test('directive text is trimmed and capped at 400 characters', () => {
	const { home, projectRoot } = makeFixture('long-directive');
	const filler = 'x'.repeat(500);
	writeProjectMemory(projectRoot, `# Rules\n\n- NEVER ${filler} end of sentence here.\n`);

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'NEVER');

	assert.ok(hit);
	assert.ok(hit.text.length <= MAX_DIRECTIVE_CHARS);
});

test('identical (text, sourcePath, line) triples are deduplicated', () => {
	const { home, projectRoot } = makeFixture('dedup');
	// Two literally identical bullets: a pathological but real-world-possible
	// copy/paste duplication within the same file.
	writeProjectMemory(
		projectRoot,
		'# Rules\n\n- NEVER duplicate this exact rule.\n- NEVER duplicate this exact rule.\n',
	);

	const result = scanDirectives({ home, projectRoot });
	const matches = result.directives.filter((d) => d.text.includes('duplicate this exact rule'));

	// Same text but different line numbers -- NOT a dedup collision, both count.
	assert.equal(matches.length, 2);
});

test('totals arithmetic: byKind, bySeverity and alwaysLoaded/onDemand all sum to total', () => {
	const { home, projectRoot } = makeFixture('totals');
	writeProjectMemory(
		projectRoot,
		['# Rules', '', '- NEVER remove the guard.', '- ALWAYS check the token.', ''].join('\n'),
	);
	fs.writeFileSync(
		path.join(projectRoot, '.ai-config', 'shared', 'rules', 'style.md'),
		'# Style\n\n- SHOULD prefer small functions.\n',
	);
	const nestedDir = path.join(projectRoot, 'nested');
	fs.mkdirSync(nestedDir, { recursive: true });
	fs.writeFileSync(path.join(nestedDir, 'CLAUDE.md'), '- MANDATORY: review before merge.\n');

	const result = scanDirectives({ home, projectRoot });
	const { totals } = result;

	assert.equal(totals.total, result.directives.length);
	assert.ok(totals.total >= 4);

	const byKindSum = Object.values(totals.byKind).reduce((a, b) => a + b, 0);
	assert.equal(byKindSum, totals.total);

	const bySeveritySum = Object.values(totals.bySeverity).reduce((a, b) => a + b, 0);
	assert.equal(bySeveritySum, totals.total);

	assert.equal(totals.alwaysLoaded + totals.onDemand, totals.total);
	assert.equal(totals.alwaysLoaded, result.directives.filter((d) => d.alwaysLoaded).length);
});

test('a markdown table produces one directive row per table row, not one merged row for the whole table', () => {
	const { home, projectRoot } = makeFixture('table-rows');
	writeProjectMemory(
		projectRoot,
		[
			'# Rules',
			'',
			'| Area | Requirement |',
			'| --- | --- |',
			'| Secrets | NEVER commit secrets to the repo |',
			'| Backups | ALWAYS verify backup integrity before deploy |',
			'',
		].join('\n'),
	);

	const result = scanDirectives({ home, projectRoot });
	const never = result.directives.find((d) => d.keyword === 'NEVER');
	const always = result.directives.find((d) => d.keyword === 'ALWAYS');

	assert.ok(never, 'expected the NEVER table cell to surface as its own row');
	assert.ok(always, 'expected the ALWAYS table cell to surface as its own row');
	assert.equal(never.line, 5, 'each table row must anchor its own line');
	assert.equal(always.line, 6, 'each table row must anchor its own line');
	assert.notEqual(never.line, always.line, 'the two table rows must not collapse into one shared block');
	assert.ok(never.text.length < 100, 'a single table row must not balloon into a giant merged block');
	assert.ok(always.text.length < 100, 'a single table row must not balloon into a giant merged block');
});

test('a directive stated as a markdown heading is surfaced, not silently dropped', () => {
	const { home, projectRoot } = makeFixture('heading-directive');
	fs.writeFileSync(
		path.join(projectRoot, '.ai-config', 'shared', 'rules', 'import-patterns.md'),
		[
			'# Import Patterns',
			'',
			'## Critical Rules for NestJS Backend Projects',
			'',
			'### NEVER create index.ts files for barrel exports',
			'',
			'Barrel exports hide the real module graph.',
			'',
		].join('\n'),
	);

	const result = scanDirectives({ home, projectRoot });
	const hit = result.directives.find(
		(d) => d.keyword === 'NEVER' && d.text.includes('create index.ts files for barrel exports'),
	);

	assert.ok(hit, 'expected the heading-only directive to surface as a row');
	assert.equal(hit.severity, 'prohibition');
	assert.equal(hit.sourceKind, 'rule');
	assert.equal(hit.line, 5, 'anchored at the heading line itself');
});

test('the strongest explicit keyword outranks the loose "NO <WORD>" ban pattern in the same sentence', () => {
	const { home, projectRoot } = makeFixture('keyword-priority');
	writeProjectMemory(
		projectRoot,
		[
			'# Rules',
			'',
			'- NO SECRETS should ever leak, but you MUST rotate keys regularly.',
			'- NO MOCK RESPONSES are appropriate here, so NEVER fabricate example data.',
			'',
		].join('\n'),
	);

	const result = scanDirectives({ home, projectRoot });

	const requirementRow = result.directives.find((d) => d.text.includes('rotate keys regularly'));
	assert.ok(requirementRow, 'expected the MUST sentence to be found');
	assert.equal(requirementRow.keyword, 'MUST');
	assert.equal(requirementRow.severity, 'requirement', 'MUST must outrank the "NO SECRETS" ban in the same sentence');

	const prohibitionRow = result.directives.find((d) => d.text.includes('fabricate example data'));
	assert.ok(prohibitionRow, 'expected the NEVER sentence to be found');
	assert.equal(prohibitionRow.keyword, 'NEVER');
	assert.equal(
		prohibitionRow.severity,
		'prohibition',
		'explicit NEVER must outrank the earlier "NO MOCK RESPONSES" ban in the same sentence',
	);
});

test('scanDirectives never throws for a completely empty projectRoot', () => {
	const home = path.join(TMP, 'empty-root', 'home');
	const projectRoot = path.join(TMP, 'empty-root', 'project');
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(projectRoot, { recursive: true });

	let result;
	assert.doesNotThrow(() => {
		result = scanDirectives({ home, projectRoot });
	});
	assert.equal(result.error, null);
	assert.deepEqual(result.directives, []);
});
