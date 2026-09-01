import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexRules } from '../lib/codex/rules-scan.mjs';
import { scanCodexMemoryChain } from '../lib/codex/memory-chain.mjs';

// Test scaffolding writes to a temp dir only. The library under test never
// writes; that is asserted separately by the read-only grep in the validation
// suite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-rules-'));

// Fixtures deliberately use the wording `../rules-scan.mjs`'s
// BLANKET_MANDATORY_PATTERN is already known to match ("All rules in
// `.ai-config/shared/rules/` are mandatory"), not the newer live wording
// ("Every file in ... is mandatory") a sibling fix is landing separately.
// This module calls through to the shared, still-being-fixed pattern via
// `isBlanketRulesMandatory()`, so it inherits that fix automatically once it
// lands -- these tests only need to prove the delegation itself works, with
// wording guaranteed to match today.
const BLANKET_SENTENCE = 'All rules in `.ai-config/shared/rules/` are mandatory.';

function makeFixture(name) {
	const home = path.join(TMP, name, 'home');
	const codexHome = path.join(home, '.codex');
	const projectRoot = path.join(TMP, name, 'project');
	const rulesDir = path.join(projectRoot, '.ai-config', 'shared', 'rules');
	fs.mkdirSync(codexHome, { recursive: true });
	fs.mkdirSync(rulesDir, { recursive: true });
	return { home, codexHome, projectRoot, rulesDir };
}

test('a missing rules directory is reported honestly instead of thrown', () => {
	const { home, projectRoot, rulesDir } = makeFixture('no-rules-dir');
	fs.rmSync(rulesDir, { recursive: true, force: true });

	const result = scanCodexRules({ home, projectRoot });
	assert.deepEqual(result.rules, []);
	assert.ok(result.error && result.error.length > 0);
	assert.match(result.error, /ENOENT/);
	assert.equal(result.path, rulesDir);
});

test('rule files are enumerated with title, size, tokens and a stable link', () => {
	const { home, codexHome, projectRoot, rulesDir } = makeFixture('basic');
	fs.writeFileSync(path.join(rulesDir, 'code-quality.md'), '# Code Quality Standards\n\nbody text here\n');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), BLANKET_SENTENCE);

	const result = scanCodexRules({ home, projectRoot });
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
	const { home, codexHome, projectRoot, rulesDir } = makeFixture('no-heading');
	fs.writeFileSync(path.join(rulesDir, 'quirky.md'), 'no heading here, just prose\n### only an H3\n');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), BLANKET_SENTENCE);

	const result = scanCodexRules({ home, projectRoot });
	const rule = result.rules.find((r) => r.name === 'quirky.md');
	assert.equal(rule.title, 'quirky.md');
});

test('a directory entry named *.md is not treated as a rule file', () => {
	const { home, projectRoot, rulesDir } = makeFixture('dir-entry');
	fs.mkdirSync(path.join(rulesDir, 'not-a-rule.md'));

	const result = scanCodexRules({ home, projectRoot });
	assert.deepEqual(result.rules, []);
});

test('a symlinked rule file is read through to its real content', () => {
	const { home, projectRoot, rulesDir } = makeFixture('symlink-rule');
	const real = path.join(rulesDir, 'real-rule.md');
	fs.writeFileSync(real, '# Real Rule\nbody\n');
	fs.symlinkSync(real, path.join(rulesDir, 'aliased-rule.md'));

	const result = scanCodexRules({ home, projectRoot });
	const aliased = result.rules.find((r) => r.name === 'aliased-rule.md');
	assert.equal(aliased.title, 'Real Rule');
	assert.ok(aliased.bytes > 0);
});

test('a rule cited by filename in the project root AGENTS.md is citedExplicitly, naming the symlink path Codex reads', () => {
	const { home, codexHome, projectRoot, rulesDir } = makeFixture('cited-project');
	fs.writeFileSync(path.join(rulesDir, 'backend-nestjs.md'), '# NestJS Backend Patterns\n');
	fs.writeFileSync(path.join(rulesDir, 'uncited-rule.md'), '# Uncited Rule\n');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');

	// The project root AGENTS.md is a symlink to a "real" doc elsewhere in the
	// repo, mirroring the AGENTS.md -> .claude/CLAUDE.md convention this panel
	// itself was extracted from.
	const realDoc = path.join(projectRoot, '.claude', 'CLAUDE.md');
	fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
	fs.writeFileSync(
		realDoc,
		[
			'# Project Instructions',
			'',
			`${BLANKET_SENTENCE} Key rules:`,
			'',
			'- `backend-nestjs.md` -- ConfigService + OnModuleInit for env vars',
			'',
		].join('\n'),
	);
	fs.symlinkSync(realDoc, path.join(projectRoot, 'AGENTS.md'));

	const result = scanCodexRules({ home, projectRoot });
	const cited = result.rules.find((r) => r.name === 'backend-nestjs.md');
	const uncited = result.rules.find((r) => r.name === 'uncited-rule.md');

	assert.equal(cited.mandatory, true);
	assert.equal(cited.citedExplicitly, true);
	assert.equal(cited.referencedBy.length, 1);
	// Must name the symlink path Codex reads, never the resolved .claude/CLAUDE.md target.
	assert.equal(cited.referencedBy[0].file, path.join(projectRoot, 'AGENTS.md'));
	assert.equal(cited.referencedBy[0].line, 5);
	assert.equal(cited.referencedBy[0].link, `vscode://file${path.join(projectRoot, 'AGENTS.md')}:5`);

	// The blanket statement still covers rules that are never named individually.
	assert.equal(uncited.mandatory, true);
	assert.equal(uncited.citedExplicitly, false);
	assert.deepEqual(uncited.referencedBy, []);
});

test('a rule cited by filename in the user AGENTS.md is also citedExplicitly', () => {
	const { home, codexHome, projectRoot, rulesDir } = makeFixture('cited-user');
	fs.writeFileSync(path.join(rulesDir, 'gcp-operations.md'), '# GCP Operations\n');
	fs.writeFileSync(
		path.join(codexHome, 'AGENTS.md'),
		['# Personal defaults', '', BLANKET_SENTENCE, '', '- `gcp-operations.md` for gcloud commands', ''].join('\n'),
	);
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'root\n');

	const result = scanCodexRules({ home, projectRoot });
	const cited = result.rules.find((r) => r.name === 'gcp-operations.md');

	assert.equal(cited.citedExplicitly, true);
	assert.equal(cited.referencedBy[0].file, path.join(codexHome, 'AGENTS.md'));
});

test('a filename citation and a blanket statement that exist only in a file Codex shadows are not counted', () => {
	const { home, codexHome, projectRoot, rulesDir } = makeFixture('shadowed-citation');
	fs.writeFileSync(path.join(rulesDir, 'some-rule.md'), '# Some Rule\n');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), `${BLANKET_SENTENCE} See \`some-rule.md\`.\n`);
	// A non-empty override replaces the plain AGENTS.md above outright.
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.override.md'), 'override content, no rule citation here.\n');

	const result = scanCodexRules({ home, projectRoot });
	const rule = result.rules.find((r) => r.name === 'some-rule.md');

	assert.equal(rule.citedExplicitly, false, 'the shadowed AGENTS.md citation must not count');
	assert.equal(rule.mandatory, false, 'the shadowed AGENTS.md blanket statement must not count either');
});

test('mandatory is derived from an actual blanket statement in a citing document, never assumed true', () => {
	const { home, codexHome, projectRoot, rulesDir } = makeFixture('no-blanket');
	fs.writeFileSync(path.join(rulesDir, 'some-rule.md'), '# Some Rule\n');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user, unrelated text\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'root, also unrelated text\n');

	const result = scanCodexRules({ home, projectRoot });
	const rule = result.rules.find((r) => r.name === 'some-rule.md');
	assert.equal(rule.mandatory, false);
	assert.equal(rule.citedExplicitly, false);
});

test('rules are returned in a stable, sorted order', () => {
	const { home, codexHome, projectRoot, rulesDir } = makeFixture('sorted');
	fs.writeFileSync(path.join(rulesDir, 'zeta.md'), '# Zeta\n');
	fs.writeFileSync(path.join(rulesDir, 'alpha.md'), '# Alpha\n');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'root\n');

	const result = scanCodexRules({ home, projectRoot });
	assert.deepEqual(
		result.rules.map((r) => r.name),
		['alpha.md', 'zeta.md'],
	);
});

test('scanCodexRules requires absolute home and projectRoot', () => {
	assert.throws(() => scanCodexRules({}), TypeError);
	assert.throws(() => scanCodexRules({ home: '/only-home' }), TypeError);
});

// Real machine, real project root -- no fixture directory involved. Home comes
// from the OS so this runs on whoever's machine executes it; the project root
// defaults to this panel's own checkout (one level up from `test/`) but can be
// pointed at any other real repo via HARNESS_REALITY_REPO.
const REAL_HOME = os.homedir();
const REAL_PROJECT_ROOT = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
const REAL_RULES_DIR = path.join(REAL_PROJECT_ROOT, '.ai-config', 'shared', 'rules');
const REAL_FIXTURES_EXIST = fs.existsSync(path.join(REAL_HOME, '.codex')) && fs.existsSync(REAL_RULES_DIR);

test(
	'reality: scanCodexRules against a real ~/.codex + project root never throws',
	{
		skip:
			!REAL_FIXTURES_EXIST &&
			'requires a real ~/.codex directory and a project root with .ai-config/shared/rules on this machine',
	},
	() => {
		let result;
		assert.doesNotThrow(() => {
			result = scanCodexRules({ home: REAL_HOME, projectRoot: REAL_PROJECT_ROOT });
		});
		assert.equal(result.error, null);
		assert.ok(result.rules.length > 0, 'expected at least one real shared rule to be enumerated');

		const withCitation = result.rules.find((r) => r.referencedBy.length > 0);
		if (withCitation) {
			assert.equal(withCitation.referencedBy[0].file, path.join(REAL_PROJECT_ROOT, 'AGENTS.md'));
		}

		const chain = scanCodexMemoryChain({ home: REAL_HOME, projectRoot: REAL_PROJECT_ROOT }).entries;
		const repoAgents = chain.find((e) => e.path === path.join(REAL_PROJECT_ROOT, 'AGENTS.md'));
		assert.ok(repoAgents);
		// isSymlink depends on how the target repo happens to lay out AGENTS.md,
		// not on scanner behaviour -- only its type is a real invariant here.
		assert.equal(typeof repoAgents.isSymlink, 'boolean');
	},
);
