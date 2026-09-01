import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LARGE_MEMORY_FILE_CHARS, memoryChainTotals, scanMemoryChain } from '../lib/memory-chain.mjs';

// Test scaffolding writes to a temp dir only. The library under test never
// writes; that is asserted separately by the read-only grep in the validation
// suite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-memory-'));

function makeFixture(name) {
	const home = path.join(TMP, name, 'home');
	const projectRoot = path.join(TMP, name, 'project');
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
	return { home, projectRoot };
}

test('the chain covers user memory, project memory and the AGENTS.md symlink, in that order', () => {
	const { home, projectRoot } = makeFixture('basic');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# User memory\nglobal prefs\n');
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), '# Project memory\nrepo rules\n');
	fs.symlinkSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), path.join(projectRoot, 'AGENTS.md'));

	const entries = scanMemoryChain({ home, projectRoot });

	assert.equal(entries[0].path, path.join(home, '.claude', 'CLAUDE.md'));
	assert.equal(entries[0].alwaysInjected, true);
	assert.equal(entries[0].exists, true);
	assert.equal(entries[0].content, '# User memory\nglobal prefs\n');
	assert.equal(entries[0].error, null);

	assert.equal(entries[1].path, path.join(projectRoot, '.claude', 'CLAUDE.md'));
	assert.equal(entries[1].alwaysInjected, true);
	assert.equal(entries[1].content, '# Project memory\nrepo rules\n');

	assert.equal(entries[2].path, path.join(projectRoot, 'AGENTS.md'));
	assert.equal(entries[2].isSymlink, true);
	assert.equal(entries[2].symlinkTarget, fs.realpathSync(path.join(projectRoot, '.claude', 'CLAUDE.md')));
	assert.equal(entries[2].alwaysInjected, false);
});

test('every entry carries an absolute path, a 1-based line anchor via link, and estimated tokens', () => {
	const { home, projectRoot } = makeFixture('shape');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'a'.repeat(400));
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), 'b'.repeat(40));

	const entries = scanMemoryChain({ home, projectRoot });
	const user = entries[0];
	assert.equal(user.link, `vscode://file${user.path}:1`);
	assert.equal(user.estimatedTokens, 100);
	assert.equal(user.bytes, 400);
});

test('a missing user memory file surfaces the real ENOENT error, never a fabricated placeholder', () => {
	const { home, projectRoot } = makeFixture('missing-user');
	fs.rmSync(path.join(home, '.claude', 'CLAUDE.md'), { force: true });
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), 'ok\n');

	const entries = scanMemoryChain({ home, projectRoot });
	const user = entries[0];
	assert.equal(user.exists, false);
	assert.equal(user.content, null);
	assert.equal(user.bytes, 0);
	assert.match(user.error, /ENOENT/);
	// alwaysInjected describes the SLOT, not whether the file happens to exist.
	assert.equal(user.alwaysInjected, true);
});

test('a broken AGENTS.md symlink is reported honestly, not silently dropped', () => {
	const { home, projectRoot } = makeFixture('broken-symlink');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), 'project\n');
	fs.symlinkSync(path.join(projectRoot, '.claude', 'nope.md'), path.join(projectRoot, 'AGENTS.md'));

	const entries = scanMemoryChain({ home, projectRoot });
	const agents = entries[2];
	assert.equal(agents.isSymlink, true);
	assert.equal(agents.exists, true);
	assert.ok(agents.error && agents.error.length > 0);
});

test('nested directory CLAUDE.md files are discovered, ordered, and scoped to their directory', () => {
	const { home, projectRoot } = makeFixture('nested');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), 'project\n');

	const nestedA = path.join(projectRoot, 'packages', 'a');
	const nestedB = path.join(projectRoot, 'apps', 'b', 'deep');
	fs.mkdirSync(nestedA, { recursive: true });
	fs.mkdirSync(nestedB, { recursive: true });
	fs.writeFileSync(path.join(nestedA, 'CLAUDE.md'), '# A scope\n');
	fs.writeFileSync(path.join(nestedB, 'CLAUDE.md'), '# B scope\n');

	const entries = scanMemoryChain({ home, projectRoot });
	const nested = entries.filter(
		(entry) =>
			entry.path.endsWith('CLAUDE.md') &&
			!entry.path.startsWith(path.join(projectRoot, '.claude')) &&
			!entry.path.startsWith(path.join(home, '.claude')),
	);

	assert.equal(nested.length, 2);
	assert.ok(nested.every((entry) => entry.alwaysInjected === false));
	const paths = nested.map((entry) => entry.path).sort();
	assert.deepEqual(paths, [path.join(nestedA, 'CLAUDE.md'), path.join(nestedB, 'CLAUDE.md')].sort());
	const a = nested.find((entry) => entry.path === path.join(nestedA, 'CLAUDE.md'));
	assert.equal(a.scopeDir, nestedA);
});

test('the nested walk skips node_modules, .git, dist, build and any /undefined/ segment', () => {
	const { home, projectRoot } = makeFixture('skip-dirs');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), 'project\n');

	const skippable = [
		['node_modules', 'pkg'],
		['.git', 'hooks'],
		['dist', 'out'],
		['build', 'out'],
		['weird', 'undefined'],
	];
	for (const segments of skippable) {
		const dir = path.join(projectRoot, ...segments);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'should not be found\n');
	}
	const keptDir = path.join(projectRoot, 'kept');
	fs.mkdirSync(keptDir, { recursive: true });
	fs.writeFileSync(path.join(keptDir, 'CLAUDE.md'), 'should be found\n');

	const entries = scanMemoryChain({ home, projectRoot });
	const nestedPaths = entries
		.map((entry) => entry.path)
		.filter(
			(p) =>
				p.startsWith(projectRoot) &&
				p !== path.join(projectRoot, '.claude', 'CLAUDE.md') &&
				p !== path.join(projectRoot, 'AGENTS.md'),
		);

	assert.deepEqual(nestedPaths, [path.join(keptDir, 'CLAUDE.md')]);
});

test('nested walk does not follow symlinked directories (cycle safety)', () => {
	const { home, projectRoot } = makeFixture('symlink-dir');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user\n');
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), 'project\n');

	const real = path.join(projectRoot, 'real-dir');
	fs.mkdirSync(real, { recursive: true });
	fs.writeFileSync(path.join(real, 'CLAUDE.md'), 'real\n');
	fs.symlinkSync(real, path.join(projectRoot, 'linked-dir'));

	const entries = scanMemoryChain({ home, projectRoot });
	const nestedPaths = entries
		.map((entry) => entry.path)
		.filter((p) => p.includes('real-dir') || p.includes('linked-dir'));
	assert.deepEqual(nestedPaths, [path.join(real, 'CLAUDE.md')]);
});

test('headings are extracted with text, level, line and a deep link', () => {
	const { home, projectRoot } = makeFixture('headings');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user\n');
	const projectMemory = path.join(projectRoot, '.claude', 'CLAUDE.md');
	fs.writeFileSync(projectMemory, '# Title\nintro\n## Section One\nbody\n### Sub\nmore\n');

	const entries = scanMemoryChain({ home, projectRoot });
	const project = entries[1];
	assert.deepEqual(project.headings, [
		{ text: 'Title', level: 1, line: 1, link: `vscode://file${projectMemory}:1` },
		{ text: 'Section One', level: 2, line: 3, link: `vscode://file${projectMemory}:3` },
		{ text: 'Sub', level: 3, line: 5, link: `vscode://file${projectMemory}:5` },
	]);
});

test('extractHeadings skips "#" lines that sit inside a fenced code block', () => {
	const { home, projectRoot } = makeFixture('fenced-headings');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user\n');
	const projectMemory = path.join(projectRoot, '.claude', 'CLAUDE.md');
	fs.writeFileSync(
		projectMemory,
		[
			'# Real Heading',
			'intro',
			'```',
			'# verbs: setup | review | task',
			'# $CODEX_PLUGIN = ~/.claude/plugins/cache/openai-codex/codex/<version>',
			'```',
			'## Another Real Heading',
			'',
		].join('\n'),
	);

	const entries = scanMemoryChain({ home, projectRoot });
	const project = entries[1];
	assert.deepEqual(
		project.headings.map((h) => h.text),
		['Real Heading', 'Another Real Heading'],
	);
});

test('extractHeadings treats "~~~" fences the same way as "```" fences', () => {
	const { home, projectRoot } = makeFixture('tilde-fenced-headings');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user\n');
	const projectMemory = path.join(projectRoot, '.claude', 'CLAUDE.md');
	fs.writeFileSync(projectMemory, ['# Title', '~~~', '# not a heading', '~~~', '## Trailer', ''].join('\n'));

	const entries = scanMemoryChain({ home, projectRoot });
	const project = entries[1];
	assert.deepEqual(
		project.headings.map((h) => h.text),
		['Title', 'Trailer'],
	);
});

test('large memory files trip the size warning at the documented floor', () => {
	const { home, projectRoot } = makeFixture('large');
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'x'.repeat(10));
	fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), 'y'.repeat(LARGE_MEMORY_FILE_CHARS + 1));

	const entries = scanMemoryChain({ home, projectRoot });
	assert.equal(entries[0].tripsLargeFileWarning, false);
	assert.equal(entries[1].tripsLargeFileWarning, true);
	assert.equal(LARGE_MEMORY_FILE_CHARS, 40000);
});

test('scanMemoryChain requires absolute home and projectRoot', () => {
	assert.throws(() => scanMemoryChain({ home: '/only-home' }), TypeError);
	assert.throws(() => scanMemoryChain({}), TypeError);
});

test('memoryChainTotals sums bytes and tokens for always-injected entries only', () => {
	const entries = [
		{
			path: '/a/CLAUDE.md',
			alwaysInjected: true,
			isSymlink: false,
			symlinkTarget: null,
			bytes: 100,
			estimatedTokens: 25,
		},
		{
			path: '/b/CLAUDE.md',
			alwaysInjected: true,
			isSymlink: false,
			symlinkTarget: null,
			bytes: 200,
			estimatedTokens: 50,
		},
		{
			path: '/c/AGENTS.md',
			alwaysInjected: false,
			isSymlink: true,
			symlinkTarget: '/b/CLAUDE.md',
			bytes: 200,
			estimatedTokens: 50,
		},
		{
			path: '/d/nested/CLAUDE.md',
			alwaysInjected: false,
			isSymlink: false,
			symlinkTarget: null,
			bytes: 30,
			estimatedTokens: 8,
		},
	];
	const totals = memoryChainTotals(entries);
	assert.deepEqual(totals, { alwaysInjectedBytes: 300, alwaysInjectedTokens: 75, fileCount: 2 });
});

test('memoryChainTotals never counts the same resolved file twice', () => {
	const entries = [
		{
			path: '/a/CLAUDE.md',
			alwaysInjected: true,
			isSymlink: false,
			symlinkTarget: null,
			bytes: 100,
			estimatedTokens: 25,
		},
		// Contrived: an always-injected entry whose symlink target resolves to the
		// same real file as the entry above. Totals must dedupe by real identity.
		{
			path: '/b/alias.md',
			alwaysInjected: true,
			isSymlink: true,
			symlinkTarget: '/a/CLAUDE.md',
			bytes: 100,
			estimatedTokens: 25,
		},
	];
	const totals = memoryChainTotals(entries);
	assert.deepEqual(totals, { alwaysInjectedBytes: 100, alwaysInjectedTokens: 25, fileCount: 1 });
});

test('memoryChainTotals tolerates empty and malformed input rather than throwing', () => {
	assert.deepEqual(memoryChainTotals([]), { alwaysInjectedBytes: 0, alwaysInjectedTokens: 0, fileCount: 0 });
	assert.deepEqual(memoryChainTotals(undefined), { alwaysInjectedBytes: 0, alwaysInjectedTokens: 0, fileCount: 0 });
});
