import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRules } from '../lib/rules-scan.mjs';

// Test scaffolding writes to a temp dir only. The library under test never
// writes; that is asserted separately by the read-only grep in the validation
// suite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rules-'));

function makeProject(name) {
	const projectRoot = path.join(TMP, name);
	const rulesDir = path.join(projectRoot, '.ai-config', 'shared', 'rules');
	fs.mkdirSync(rulesDir, { recursive: true });
	fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
	return { projectRoot, rulesDir };
}

test('a missing rules directory is reported honestly instead of thrown', () => {
	const projectRoot = path.join(TMP, 'no-rules-dir');
	fs.mkdirSync(projectRoot, { recursive: true });

	const result = scanRules({ projectRoot });
	assert.deepEqual(result.rules, []);
	assert.ok(result.error && result.error.length > 0);
	assert.match(result.error, /ENOENT/);
	assert.equal(result.path, path.join(projectRoot, '.ai-config', 'shared', 'rules'));
});

test('rule files are enumerated with title, size, tokens and a stable link', () => {
	const { projectRoot, rulesDir } = makeProject('basic');
	fs.writeFileSync(path.join(rulesDir, 'code-quality.md'), '# Code Quality Standards\n\nbody text here\n');
	fs.writeFileSync(
		path.join(projectRoot, '.claude', 'CLAUDE.md'),
		'All rules in `.ai-config/shared/rules/` are mandatory.\n',
	);

	const result = scanRules({ projectRoot });
	assert.equal(result.error, null);
	assert.equal(result.rules.length, 1);
	const rule = result.rules[0];
	assert.equal(rule.name, 'code-quality.md');
	assert.equal(rule.path, path.join(rulesDir, 'code-quality.md'));
	assert.equal(rule.line, 1);
	assert.equal(rule.link, `vscode://file${rule.path}:1`);
	assert.equal(rule.title, 'Code Quality Standards');
	assert.ok(rule.bytes > 0);
	assert.ok(rule.estimatedTokens > 0);
	assert.equal(rule.error, null);
});

test('a rule file with no H1/H2 heading falls back to its filename as the title', () => {
	const { projectRoot, rulesDir } = makeProject('no-heading');
	fs.writeFileSync(path.join(rulesDir, 'quirky.md'), 'no heading here, just prose\n### only an H3\n');
	fs.writeFileSync(
		path.join(projectRoot, '.claude', 'CLAUDE.md'),
		'All rules in `.ai-config/shared/rules/` are mandatory.\n',
	);

	const result = scanRules({ projectRoot });
	const rule = result.rules.find((r) => r.name === 'quirky.md');
	assert.equal(rule.title, 'quirky.md');
});

test('a directory entry that happens to be named *.md is not treated as a rule file', () => {
	const { projectRoot, rulesDir } = makeProject('dir-entry');
	fs.mkdirSync(path.join(rulesDir, 'not-a-rule.md'));
	fs.writeFileSync(
		path.join(projectRoot, '.claude', 'CLAUDE.md'),
		'All rules in `.ai-config/shared/rules/` are mandatory.\n',
	);

	const result = scanRules({ projectRoot });
	assert.deepEqual(result.rules, []);
});

test('a symlinked rule file is read through to its real content', () => {
	const { projectRoot, rulesDir } = makeProject('symlink-rule');
	const real = path.join(rulesDir, 'real-rule.md');
	fs.writeFileSync(real, '# Real Rule\nbody\n');
	fs.symlinkSync(real, path.join(rulesDir, 'aliased-rule.md'));
	fs.writeFileSync(
		path.join(projectRoot, '.claude', 'CLAUDE.md'),
		'All rules in `.ai-config/shared/rules/` are mandatory.\n',
	);

	const result = scanRules({ projectRoot });
	const aliased = result.rules.find((r) => r.name === 'aliased-rule.md');
	assert.equal(aliased.title, 'Real Rule');
	assert.ok(aliased.bytes > 0);
});

test('a rule cited by filename in the project CLAUDE.md is marked citedExplicitly with a working link', () => {
	const { projectRoot, rulesDir } = makeProject('cited');
	fs.writeFileSync(path.join(rulesDir, 'backend-nestjs.md'), '# NestJS Backend Patterns\n');
	fs.writeFileSync(path.join(rulesDir, 'uncited-rule.md'), '# Uncited Rule\n');
	const claudeMdPath = path.join(projectRoot, '.claude', 'CLAUDE.md');
	fs.writeFileSync(
		claudeMdPath,
		[
			'# Project Instructions',
			'',
			'All rules in `.ai-config/shared/rules/` are mandatory. Key rules:',
			'',
			'- `backend-nestjs.md` -- ConfigService + OnModuleInit for env vars',
			'',
		].join('\n'),
	);

	const result = scanRules({ projectRoot });
	const cited = result.rules.find((r) => r.name === 'backend-nestjs.md');
	const uncited = result.rules.find((r) => r.name === 'uncited-rule.md');

	assert.equal(cited.mandatory, true);
	assert.equal(cited.citedExplicitly, true);
	assert.equal(cited.referencedBy.length, 1);
	assert.equal(cited.referencedBy[0].file, claudeMdPath);
	assert.equal(cited.referencedBy[0].line, 5);
	assert.equal(cited.referencedBy[0].link, `vscode://file${claudeMdPath}:5`);

	// The blanket statement still covers rules that are never named individually.
	assert.equal(uncited.mandatory, true);
	assert.equal(uncited.citedExplicitly, false);
	assert.deepEqual(uncited.referencedBy, []);
});

test('mandatory is derived from the actual blanket statement, not assumed true', () => {
	const { projectRoot, rulesDir } = makeProject('no-blanket-statement');
	fs.writeFileSync(path.join(rulesDir, 'some-rule.md'), '# Some Rule\n');
	// CLAUDE.md exists but never actually states the blanket "all rules are
	// mandatory" sentence -- nothing here licenses calling every rule mandatory.
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), '# Project Instructions\nSome unrelated text.\n');

	const result = scanRules({ projectRoot });
	const rule = result.rules.find((r) => r.name === 'some-rule.md');
	assert.equal(rule.mandatory, false);
	assert.equal(rule.citedExplicitly, false);
});

test('a missing project CLAUDE.md still enumerates rules, honestly derived as non-mandatory', () => {
	const { projectRoot, rulesDir } = makeProject('no-claude-md');
	fs.writeFileSync(path.join(rulesDir, 'some-rule.md'), '# Some Rule\n');
	fs.rmSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), { force: true });

	const result = scanRules({ projectRoot });
	assert.equal(result.error, null);
	assert.equal(result.rules.length, 1);
	assert.equal(result.rules[0].mandatory, false);
	assert.deepEqual(result.rules[0].referencedBy, []);
});

test('rules are returned in a stable, sorted order', () => {
	const { projectRoot, rulesDir } = makeProject('sorted');
	fs.writeFileSync(path.join(rulesDir, 'zeta.md'), '# Zeta\n');
	fs.writeFileSync(path.join(rulesDir, 'alpha.md'), '# Alpha\n');
	fs.writeFileSync(
		path.join(projectRoot, '.claude', 'CLAUDE.md'),
		'All rules in `.ai-config/shared/rules/` are mandatory.\n',
	);

	const result = scanRules({ projectRoot });
	assert.deepEqual(
		result.rules.map((r) => r.name),
		['alpha.md', 'zeta.md'],
	);
});

test('the blanket-mandatory pattern recognizes the current CLAUDE.md wording, not just the historic phrasing', () => {
	const { projectRoot, rulesDir } = makeProject('live-wording');
	fs.writeFileSync(path.join(rulesDir, 'some-rule.md'), '# Some Rule\n');
	// Pinned verbatim to a real-world .claude/CLAUDE.md section 2 sentence
	// (not the "All rules ... are mandatory" phrasing the old regex assumed).
	// If that source wording ever changes again, this fixture will keep
	// matching the OLD wording while the live one drifts -- a future reader
	// should re-pin it to whatever CLAUDE.md actually says.
	fs.writeFileSync(
		path.join(projectRoot, '.claude', 'CLAUDE.md'),
		[
			'## 2. Shared Rules',
			'',
			'Every file in `.ai-config/shared/rules/` is mandatory. They hold what the code cannot state on',
			'its own — constraints, prohibitions and procedures.',
			'',
		].join('\n'),
	);

	const result = scanRules({ projectRoot });
	assert.equal(result.rules.length, 1);
	assert.equal(result.rules[0].mandatory, true);
});

test('reasonable variants of the blanket-mandatory sentence are also recognized', () => {
	const variants = [
		'All rules under the shared rules directory are mandatory.',
		'Every rule in `.ai-config/shared/rules/` is mandatory.',
		'All files in shared rules are mandatory for every contributor.',
	];
	for (const sentence of variants) {
		const { projectRoot, rulesDir } = makeProject(`variant-${variants.indexOf(sentence)}`);
		fs.writeFileSync(path.join(rulesDir, 'some-rule.md'), '# Some Rule\n');
		fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), sentence);

		const result = scanRules({ projectRoot });
		assert.equal(result.rules[0].mandatory, true, `expected "${sentence}" to be recognized as blanket-mandatory`);
	}
});

test('scanRules requires an absolute projectRoot', () => {
	assert.throws(() => scanRules({}), TypeError);
});
