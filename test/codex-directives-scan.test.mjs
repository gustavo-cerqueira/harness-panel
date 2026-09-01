import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexDirectives } from '../lib/codex/directives-scan.mjs';
import { scanCodexMemoryChain } from '../lib/codex/memory-chain.mjs';

// Test scaffolding writes to a temp dir only. The library under test never
// writes; that is asserted separately by the read-only grep in the validation
// suite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-directives-'));

/**
 * A fresh fixture with a harmless, directive-free user + project AGENTS.md
 * already in place, plus an empty shared rules directory, so a test that only
 * cares about one side of the scan does not have to worry about unrelated
 * ENOENT noise.
 */
function makeFixture(name) {
	const home = path.join(TMP, name, 'home');
	const codexHome = path.join(home, '.codex');
	const projectRoot = path.join(TMP, name, 'project');
	const rulesDir = path.join(projectRoot, '.ai-config', 'shared', 'rules');
	fs.mkdirSync(codexHome, { recursive: true });
	fs.mkdirSync(rulesDir, { recursive: true });
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# User\nordinary preferences\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Project\nplaceholder\n');
	return { home, codexHome, projectRoot, rulesDir };
}

test('an ALL-CAPS NEVER in the project root AGENTS.md is captured as project-memory, always loaded', () => {
	const { home, projectRoot } = makeFixture('root-never');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Rules\n\n- NEVER delete the audit log.\n');

	const result = scanCodexDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'NEVER' && d.text.includes('delete the audit log'));

	assert.ok(hit, 'expected a NEVER directive to be found');
	assert.equal(hit.severity, 'prohibition');
	assert.equal(hit.sourceKind, 'project-memory');
	assert.equal(hit.alwaysLoaded, true);
	assert.equal(hit.sourcePath, path.join(projectRoot, 'AGENTS.md'));
	assert.equal(hit.link, `vscode://file${hit.sourcePath}:3`);
});

test('a directive in the user AGENTS.md is captured as user-memory, always loaded', () => {
	const { home, codexHome, projectRoot } = makeFixture('user-never');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# User\n\n- NEVER skip the safety check.\n');

	const result = scanCodexDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'NEVER');

	assert.ok(hit);
	assert.equal(hit.sourceKind, 'user-memory');
	assert.equal(hit.alwaysLoaded, true);
});

test('a directive in a nested AGENTS.md candidate is captured as nested-memory, on demand', () => {
	const { home, projectRoot } = makeFixture('nested-never');
	const nested = path.join(projectRoot, 'packages', 'a');
	fs.mkdirSync(nested, { recursive: true });
	fs.writeFileSync(path.join(nested, 'AGENTS.md'), '- NEVER touch the nested config directly.\n');

	const result = scanCodexDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.text.includes('nested config'));

	assert.ok(hit);
	assert.equal(hit.sourceKind, 'nested-memory');
	assert.equal(hit.alwaysLoaded, false);
});

test('a directive that exists only in a file Codex shadows with AGENTS.override.md is never reported', () => {
	const { home, projectRoot } = makeFixture('shadowed');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '- NEVER read this shadowed rule.\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.override.md'), '- ALWAYS read this override rule instead.\n');

	const result = scanCodexDirectives({ home, projectRoot });
	const shadowedHit = result.directives.find((d) => d.text.includes('shadowed rule'));
	const overrideHit = result.directives.find((d) => d.text.includes('override rule instead'));

	assert.equal(shadowedHit, undefined, 'a file Codex never injects here must not surface a directive');
	assert.ok(overrideHit, 'the file Codex actually injects must still surface its directive');
	assert.equal(overrideHit.sourceKind, 'project-memory');
	assert.equal(overrideHit.alwaysLoaded, true);
});

test('rule files are scanned with sourceKind "rule" and alwaysLoaded false', () => {
	const { home, projectRoot, rulesDir } = makeFixture('rule-file');
	fs.writeFileSync(
		path.join(rulesDir, 'some-rule.md'),
		'# Some Rule\n\n- SHOULD prefer explicit config over defaults.\n',
	);

	const result = scanCodexDirectives({ home, projectRoot });
	const hit = result.directives.find((d) => d.keyword === 'SHOULD');

	assert.ok(hit);
	assert.equal(hit.severity, 'caution');
	assert.equal(hit.sourceKind, 'rule');
	assert.equal(hit.alwaysLoaded, false);
});

test('a missing user AGENTS.md is recorded in scanned with its real error, and never fails the whole scan', () => {
	const { home, codexHome, projectRoot } = makeFixture('missing-user');
	fs.rmSync(path.join(codexHome, 'AGENTS.md'), { force: true });

	const result = scanCodexDirectives({ home, projectRoot });
	const entry = result.scanned.find((s) => s.kind === 'user-memory');

	assert.ok(entry, 'expected a scanned entry for the user AGENTS.md even though it is missing');
	assert.ok(entry.error && /ENOENT/.test(entry.error));
	assert.equal(result.error, null, 'a single missing source file must not fail the whole scan');
});

test('a missing shared rules directory is recorded honestly rather than thrown', () => {
	const { home, projectRoot, rulesDir } = makeFixture('missing-rules-dir');
	fs.rmSync(rulesDir, { recursive: true, force: true });

	assert.doesNotThrow(() => scanCodexDirectives({ home, projectRoot }));
	const result = scanCodexDirectives({ home, projectRoot });
	const ruleEntry = result.scanned.find((s) => s.kind === 'rule');

	assert.ok(ruleEntry, 'expected the missing rules directory to still surface a scanned entry');
	assert.ok(ruleEntry.error && ruleEntry.error.length > 0);
});

test('totals arithmetic: byKind, bySeverity and alwaysLoaded/onDemand all sum to total', () => {
	const { home, projectRoot, rulesDir } = makeFixture('totals');
	fs.writeFileSync(
		path.join(projectRoot, 'AGENTS.md'),
		['# Rules', '', '- NEVER remove the guard.', '- ALWAYS check the token.', ''].join('\n'),
	);
	fs.writeFileSync(path.join(rulesDir, 'style.md'), '# Style\n\n- SHOULD prefer small functions.\n');
	const nestedDir = path.join(projectRoot, 'nested');
	fs.mkdirSync(nestedDir, { recursive: true });
	fs.writeFileSync(path.join(nestedDir, 'AGENTS.md'), '- MANDATORY: review before merge.\n');

	const result = scanCodexDirectives({ home, projectRoot });
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

test('scanCodexDirectives reports an error rather than throwing for a missing home/projectRoot', () => {
	const result = scanCodexDirectives({});
	assert.deepEqual(result.directives, []);
	assert.ok(result.error && result.error.length > 0);
});

test('scanCodexDirectives never throws for a completely empty projectRoot', () => {
	const home = path.join(TMP, 'empty-root', 'home');
	const projectRoot = path.join(TMP, 'empty-root', 'project');
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(projectRoot, { recursive: true });

	let result;
	assert.doesNotThrow(() => {
		result = scanCodexDirectives({ home, projectRoot });
	});
	assert.equal(result.error, null);
	assert.deepEqual(result.directives, []);
});

// Real machine, real project root -- no fixture directory involved. Home comes
// from the OS so this runs on whoever's machine executes it; the project root
// defaults to this panel's own checkout (one level up from `test/`) but can be
// pointed at any other real repo via HARNESS_REALITY_REPO.
const REAL_HOME = os.homedir();
const REAL_PROJECT_ROOT = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
const REAL_FIXTURES_EXIST = fs.existsSync(path.join(REAL_HOME, '.codex')) && fs.existsSync(REAL_PROJECT_ROOT);

test(
	'reality: scanCodexDirectives against a real ~/.codex + project root never throws',
	{ skip: !REAL_FIXTURES_EXIST && 'requires a real ~/.codex directory and an existing project root on this machine' },
	() => {
		let result;
		assert.doesNotThrow(() => {
			result = scanCodexDirectives({ home: REAL_HOME, projectRoot: REAL_PROJECT_ROOT });
		});
		assert.equal(result.error, null);
		assert.ok(Array.isArray(result.directives));

		const chain = scanCodexMemoryChain({ home: REAL_HOME, projectRoot: REAL_PROJECT_ROOT }).entries;
		const repoAgents = chain.find((e) => e.path === path.join(REAL_PROJECT_ROOT, 'AGENTS.md'));
		assert.ok(repoAgents);
		// isSymlink depends on how the target repo happens to lay out AGENTS.md,
		// not on scanner behaviour -- only its type is a real invariant here.
		assert.equal(typeof repoAgents.isSymlink, 'boolean');
	},
);
