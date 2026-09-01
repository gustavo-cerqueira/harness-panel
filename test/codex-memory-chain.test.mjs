import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	PROJECT_DOC_MAX_BYTES,
	codexMemoryChainTotals,
	readCodexMemoryChain,
	scanCodexMemoryChain,
} from '../lib/codex/memory-chain.mjs';

// Test scaffolding writes to a temp dir only. The library under test never
// writes; that is asserted separately by the read-only grep in the validation
// suite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-memory-'));

/** A fresh {home, codexHome, projectRoot} triple with the standard dirs in place. */
function makeFixture(name) {
	const home = path.join(TMP, name, 'home');
	const codexHome = path.join(home, '.codex');
	const projectRoot = path.join(TMP, name, 'project');
	fs.mkdirSync(codexHome, { recursive: true });
	fs.mkdirSync(projectRoot, { recursive: true });
	return { home, codexHome, projectRoot };
}

test('the chain covers user AGENTS.md then project root AGENTS.md, in that order', () => {
	const { home, codexHome, projectRoot } = makeFixture('basic');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# User\nglobal prefs\n');
	fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), '# Project\nrepo rules\n');
	fs.symlinkSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), path.join(projectRoot, 'AGENTS.md'));

	const { entries, truncationNote } = scanCodexMemoryChain({ home, projectRoot });
	const read = readCodexMemoryChain({ home, projectRoot }).entries;

	assert.equal(entries[0].layer, 'user');
	assert.equal(entries[0].path, path.join(codexHome, 'AGENTS.md'));
	assert.equal(entries[0].alwaysInjected, true);
	assert.equal(read[0].content, '# User\nglobal prefs\n');
	assert.equal(entries[0].error, null);

	assert.equal(entries[1].layer, 'project');
	assert.equal(entries[1].path, path.join(projectRoot, 'AGENTS.md'));
	assert.equal(entries[1].isSymlink, true);
	assert.equal(entries[1].symlinkTarget, fs.realpathSync(path.join(projectRoot, '.claude', 'CLAUDE.md')));
	assert.equal(entries[1].alwaysInjected, true);
	assert.equal(read[1].content, '# Project\nrepo rules\n');
	assert.equal(entries[1].shadowed, false);
	assert.equal(truncationNote, null);
});

test('every entry carries an absolute path, a 1-based line link, and estimated tokens', () => {
	const { home, codexHome, projectRoot } = makeFixture('shape');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'a'.repeat(400));

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	const user = entries[0];
	assert.equal(user.link, `vscode://file${user.path}:1`);
	assert.equal(user.estimatedTokens, 100);
	assert.equal(user.bytes, 400);
});

test('a missing user AGENTS.md surfaces the real ENOENT error; alwaysInjected still describes the slot', () => {
	const { home, projectRoot } = makeFixture('missing-user');

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	const user = entries[0];
	assert.equal(user.exists, false);
	assert.equal(readCodexMemoryChain({ home, projectRoot }).entries[0].content, null);
	assert.equal(user.bytes, 0);
	assert.match(user.error, /ENOENT/);
	assert.equal(user.alwaysInjected, true);
});

test('a non-empty AGENTS.override.md replaces AGENTS.md at the project root', () => {
	const { home, codexHome, projectRoot } = makeFixture('override-root');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'plain root\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.override.md'), 'override root\n');

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	const winner = entries.find((e) => e.path === path.join(projectRoot, 'AGENTS.override.md'));
	const loser = entries.find((e) => e.path === path.join(projectRoot, 'AGENTS.md'));

	assert.ok(winner, 'expected the override to be the winning entry');
	assert.equal(winner.layer, 'project');
	assert.equal(winner.alwaysInjected, true);
	assert.equal(winner.shadowed, false);
	assert.equal(
		readCodexMemoryChain({ home, projectRoot }).entries.find((e) => e.path === winner.path).content,
		'override root\n',
	);

	assert.ok(loser, 'expected the replaced AGENTS.md to still be reported');
	assert.equal(loser.alwaysInjected, false);
	assert.equal(loser.shadowed, true);
	assert.ok(loser.note && loser.note.length > 0);
});

test('an empty AGENTS.override.md falls through to AGENTS.md, not the other way around', () => {
	const { home, codexHome, projectRoot } = makeFixture('empty-override');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'plain root\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.override.md'), '');

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	const winner = entries.find((e) => e.path === path.join(projectRoot, 'AGENTS.md'));
	const loser = entries.find((e) => e.path === path.join(projectRoot, 'AGENTS.override.md'));

	assert.ok(winner);
	assert.equal(winner.alwaysInjected, true);
	assert.equal(winner.shadowed, false);
	assert.ok(loser);
	assert.equal(loser.alwaysInjected, false);
	assert.equal(loser.shadowed, true);
});

test('nested AGENTS.md files are discovered as on-demand candidates, never alwaysInjected', () => {
	const { home, codexHome, projectRoot } = makeFixture('nested');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'root\n');
	const nested = path.join(projectRoot, 'packages', 'a');
	fs.mkdirSync(nested, { recursive: true });
	fs.writeFileSync(path.join(nested, 'AGENTS.md'), '# nested scope\n');

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	const found = entries.find((e) => e.path === path.join(nested, 'AGENTS.md'));

	assert.ok(found);
	assert.equal(found.layer, 'project');
	assert.equal(found.alwaysInjected, false);
	assert.equal(found.shadowed, false);
	assert.equal(found.scopeDir, nested);
	assert.ok(found.note && found.note.length > 0);
});

test('the nested walk skips node_modules, .git, dist, build, .next and coverage', () => {
	const { home, codexHome, projectRoot } = makeFixture('skip-dirs');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'root\n');
	const skippable = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];
	for (const name of skippable) {
		const dir = path.join(projectRoot, name, 'inner');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'should not be found\n');
	}
	const kept = path.join(projectRoot, 'kept');
	fs.mkdirSync(kept, { recursive: true });
	fs.writeFileSync(path.join(kept, 'AGENTS.md'), 'should be found\n');

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	const nestedPaths = entries
		.map((e) => e.path)
		.filter((p) => p.startsWith(projectRoot) && p !== path.join(projectRoot, 'AGENTS.md'));

	assert.deepEqual(nestedPaths, [path.join(kept, 'AGENTS.md')]);
});

test('the nested walk does not descend past depth 6 below the project root', () => {
	const { home, codexHome, projectRoot } = makeFixture('deep');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'root\n');
	const deepDir = path.join(projectRoot, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'); // 7 levels
	fs.mkdirSync(deepDir, { recursive: true });
	fs.writeFileSync(path.join(deepDir, 'AGENTS.md'), 'too deep\n');
	const shallowDir = path.join(projectRoot, 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'); // 6 levels
	fs.mkdirSync(shallowDir, { recursive: true });
	fs.writeFileSync(path.join(shallowDir, 'AGENTS.md'), 'depth 6\n');

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	const paths = entries.map((e) => e.path);

	assert.ok(paths.includes(path.join(shallowDir, 'AGENTS.md')), 'depth 6 must be reached');
	assert.ok(!paths.includes(path.join(deepDir, 'AGENTS.md')), 'depth 7 must not be reached');
});

test('a project-root file over the 32 KiB budget trips the size warning and sets a top-level truncationNote', () => {
	const { home, codexHome, projectRoot } = makeFixture('over-budget');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'y'.repeat(PROJECT_DOC_MAX_BYTES + 100));

	const { entries, truncationNote } = scanCodexMemoryChain({ home, projectRoot });
	const root = entries.find((e) => e.path === path.join(projectRoot, 'AGENTS.md'));

	assert.equal(root.tripsLargeFileWarning, true);
	assert.ok(truncationNote, 'expected a top-level truncationNote');
	assert.match(truncationNote, /32/);
	assert.equal(PROJECT_DOC_MAX_BYTES, 32 * 1024);
});

test('a project-root file under the budget never sets truncationNote, and the user file is never charged against it', () => {
	const { home, codexHome, projectRoot } = makeFixture('under-budget');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'z'.repeat(PROJECT_DOC_MAX_BYTES + 100)); // large user file
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'small\n');

	const { truncationNote } = scanCodexMemoryChain({ home, projectRoot });
	assert.equal(truncationNote, null);
});

test('headings are extracted with text, level, line and a deep link', () => {
	const { home, codexHome, projectRoot } = makeFixture('headings');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user\n');
	const rootPath = path.join(projectRoot, 'AGENTS.md');
	fs.writeFileSync(rootPath, '# Title\nintro\n## Section One\nbody\n');

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	const root = entries.find((e) => e.path === rootPath);
	assert.deepEqual(root.headings, [
		{ text: 'Title', level: 1, line: 1, link: `vscode://file${rootPath}:1` },
		{ text: 'Section One', level: 2, line: 3, link: `vscode://file${rootPath}:3` },
	]);
});

test('scanCodexMemoryChain requires absolute home and projectRoot', () => {
	assert.throws(() => scanCodexMemoryChain({ home: '/only-home' }), TypeError);
	assert.throws(() => scanCodexMemoryChain({}), TypeError);
});

test('codexMemoryChainTotals sums bytes and tokens for always-injected entries only', () => {
	const entries = [
		{
			path: '/a/AGENTS.md',
			alwaysInjected: true,
			isSymlink: false,
			symlinkTarget: null,
			bytes: 100,
			estimatedTokens: 25,
		},
		{
			path: '/b/AGENTS.md',
			alwaysInjected: true,
			isSymlink: false,
			symlinkTarget: null,
			bytes: 200,
			estimatedTokens: 50,
		},
		{
			path: '/c/AGENTS.md',
			alwaysInjected: false,
			isSymlink: false,
			symlinkTarget: null,
			bytes: 30,
			estimatedTokens: 8,
		},
	];
	const totals = codexMemoryChainTotals(entries);
	assert.deepEqual(totals, { alwaysInjectedBytes: 300, alwaysInjectedTokens: 75, fileCount: 2 });
});

test('codexMemoryChainTotals never counts the same resolved symlink target twice', () => {
	const entries = [
		{
			path: '/a/AGENTS.md',
			alwaysInjected: true,
			isSymlink: false,
			symlinkTarget: null,
			bytes: 100,
			estimatedTokens: 25,
		},
		{
			path: '/b/AGENTS.md',
			alwaysInjected: true,
			isSymlink: true,
			symlinkTarget: '/a/AGENTS.md',
			bytes: 100,
			estimatedTokens: 25,
		},
	];
	const totals = codexMemoryChainTotals(entries);
	assert.deepEqual(totals, { alwaysInjectedBytes: 100, alwaysInjectedTokens: 25, fileCount: 1 });
});

test('codexMemoryChainTotals tolerates empty and malformed input rather than throwing', () => {
	assert.deepEqual(codexMemoryChainTotals([]), { alwaysInjectedBytes: 0, alwaysInjectedTokens: 0, fileCount: 0 });
	assert.deepEqual(codexMemoryChainTotals(undefined), {
		alwaysInjectedBytes: 0,
		alwaysInjectedTokens: 0,
		fileCount: 0,
	});
});

// Real machine, real project root -- no fixture directory involved. Home comes
// from the OS so this runs on whoever's machine executes it; the project root
// defaults to this panel's own checkout (one level up from `test/`) but can be
// pointed at any other real repo via HARNESS_REALITY_REPO.
const REAL_HOME = os.homedir();
const REAL_PROJECT_ROOT = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
const REAL_FIXTURES_EXIST = fs.existsSync(path.join(REAL_HOME, '.codex')) && fs.existsSync(REAL_PROJECT_ROOT);

test(
	'reality: scanCodexMemoryChain against a real ~/.codex + project root never throws',
	{ skip: !REAL_FIXTURES_EXIST && 'requires a real ~/.codex directory and an existing project root on this machine' },
	() => {
		let result;
		assert.doesNotThrow(() => {
			result = scanCodexMemoryChain({ home: REAL_HOME, projectRoot: REAL_PROJECT_ROOT });
		});
		assert.ok(Array.isArray(result.entries) && result.entries.length > 0);
		const repoAgents = result.entries.find((e) => e.path === path.join(REAL_PROJECT_ROOT, 'AGENTS.md'));
		assert.ok(repoAgents, 'expected a chain entry for the repo AGENTS.md');
		// isSymlink depends on how the target repo happens to lay out AGENTS.md,
		// not on scanner behaviour -- only its type is a real invariant here.
		assert.equal(typeof repoAgents.isSymlink, 'boolean');
	},
);

// --- the API payload must never republish an instruction file's body ---------
//
// An AGENTS.md is arbitrary repository prose. On this machine the project chain
// resolves through a symlink into a CLAUDE.md that names a live smoke-test
// credential, and `/api/state` serialises whatever a scanner returns — so a row
// carrying `content` published that credential to every reader of the panel.
// The fixture below uses a SYNTHETIC secret for exactly that reason.

const FIXTURE_SECRET = 'Sup3rS3cr3t-Fixture-Passw0rd';

test('scanCodexMemoryChain strips content from every row, including shadowed and nested ones', () => {
	const { home, codexHome, projectRoot } = makeFixture('no-content');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'user text\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'plain root\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.override.md'), 'override root\n');
	fs.mkdirSync(path.join(projectRoot, 'nested'), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, 'nested', 'AGENTS.md'), 'nested text\n');

	const { entries } = scanCodexMemoryChain({ home, projectRoot });
	assert.ok(entries.length >= 4, 'expected winner, shadowed sibling and nested candidate rows');
	for (const entry of entries) {
		assert.equal(
			Object.prototype.hasOwnProperty.call(entry, 'content'),
			false,
			`row ${entry.path} still carries a content property`,
		);
	}
	// what a reader actually needs is still there
	assert.ok(entries.every((entry) => Array.isArray(entry.headings)));
	assert.ok(entries.every((entry) => typeof entry.bytes === 'number'));
	assert.ok(entries.every((entry) => typeof entry.estimatedTokens === 'number'));
});

test('a secret inside an AGENTS.md never survives JSON.stringify(scanCodexMemoryChain(...))', () => {
	const { home, codexHome, projectRoot } = makeFixture('secret-leak');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), `# User\nUse ${FIXTURE_SECRET} for the smoke test.\n`);
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), `# Project\nPassword: ${FIXTURE_SECRET}\n`);

	const serialized = JSON.stringify(scanCodexMemoryChain({ home, projectRoot }));
	assert.equal(serialized.includes(FIXTURE_SECRET), false, 'the API-facing chain leaked the fixture secret');

	// the in-process read still has it — that is the whole point of the split
	const read = JSON.stringify(readCodexMemoryChain({ home, projectRoot }));
	assert.equal(read.includes(FIXTURE_SECRET), true);
});

test('readCodexMemoryChain and scanCodexMemoryChain agree on everything except content', () => {
	const { home, codexHome, projectRoot } = makeFixture('parity');
	fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# User\n');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Project\n');

	const read = readCodexMemoryChain({ home, projectRoot });
	const scanned = scanCodexMemoryChain({ home, projectRoot });
	assert.equal(scanned.truncationNote, read.truncationNote);
	assert.equal(scanned.entries.length, read.entries.length);
	for (let i = 0; i < read.entries.length; i += 1) {
		const { content: _content, ...rest } = read.entries[i];
		assert.deepEqual(scanned.entries[i], rest);
	}
	// stripping must not mutate the caller's in-process rows
	assert.equal(read.entries[0].content, '# User\n');
});

test('readCodexMemoryChain requires absolute home and projectRoot', () => {
	assert.throws(() => readCodexMemoryChain({ home: '/only-home' }), TypeError);
	assert.throws(() => readCodexMemoryChain({}), TypeError);
});
