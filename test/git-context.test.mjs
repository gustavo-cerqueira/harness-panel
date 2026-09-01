import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ANCHOR_REF, TRACKED_CONFIG_PATHS, divergesFromAnchor, gitContext } from '../lib/git-context.mjs';

/** Builds a throwaway repo with a dev branch and a feature branch on top. */
function makeRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-git-'));
	const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
	run('init', '-q', '-b', 'dev');
	run('config', 'user.email', 'test@example.com');
	run('config', 'user.name', 'Test');
	fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.claude', 'CLAUDE.md'), '# base\n');
	fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'not config\n');
	run('add', '-A');
	run('commit', '-qm', 'base');
	return { dir, run };
}

test('reports the branch, head and anchor of the tree it reads', () => {
	const { dir } = makeRepo();
	const context = gitContext({ projectRoot: dir });
	assert.equal(context.available, true);
	assert.equal(context.error, null);
	assert.equal(context.branch, 'dev');
	assert.equal(context.anchorRef, DEFAULT_ANCHOR_REF);
	assert.equal(context.anchorExists, true);
	assert.equal(context.head, context.anchorHead, 'on dev itself, HEAD is the anchor');
	assert.equal(context.isMainWorktree, true);
	assert.deepEqual(context.divergingFiles, []);
});

test('a feature branch that changed tracked config is reported as diverging', () => {
	const { dir, run } = makeRepo();
	run('checkout', '-q', '-b', 'feat/x');
	fs.writeFileSync(path.join(dir, '.claude', 'CLAUDE.md'), '# base\nextra rule\n');
	run('add', '-A');
	run('commit', '-qm', 'change config');

	const context = gitContext({ projectRoot: dir });
	assert.equal(context.branch, 'feat/x');
	assert.equal(context.aheadOfAnchor, 1);
	assert.equal(context.behindAnchor, 0);
	assert.deepEqual(context.divergingFiles, ['.claude/CLAUDE.md']);
	assert.equal(divergesFromAnchor(context, path.join(dir, '.claude', 'CLAUDE.md')), true);
});

test('changes outside the tracked config paths are not reported as config divergence', () => {
	const { dir, run } = makeRepo();
	run('checkout', '-q', '-b', 'feat/y');
	fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'changed\n');
	run('add', '-A');
	run('commit', '-qm', 'unrelated change');

	const context = gitContext({ projectRoot: dir });
	assert.equal(context.aheadOfAnchor, 1);
	assert.deepEqual(context.divergingFiles, [], 'a source change is not a config change');
});

test('divergesFromAnchor refuses paths outside the repo, never guessing', () => {
	const { dir } = makeRepo();
	const context = gitContext({ projectRoot: dir });
	// A user-scope file has no branch at all and must never be badged.
	assert.equal(divergesFromAnchor(context, '/Users/someone/.claude/settings.json'), false);
	assert.equal(divergesFromAnchor(context, null), false);
	assert.equal(divergesFromAnchor(null, path.join(dir, '.claude', 'CLAUDE.md')), false);
});

test('a missing anchor ref is reported, not silently read as "no divergence"', () => {
	const { dir } = makeRepo();
	const context = gitContext({ projectRoot: dir, anchorRef: 'no-such-branch' });
	assert.equal(context.anchorExists, false);
	assert.match(context.error, /no-such-branch/);
});

test('a directory that is not a git repository is reported with the real error', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-nogit-'));
	const context = gitContext({ projectRoot: dir });
	assert.equal(context.available, false);
	assert.ok(context.error && context.error.length > 0);
	assert.equal(context.divergingFiles.length, 0);
});

test('a missing projectRoot is reported, not thrown', () => {
	const context = gitContext({});
	assert.equal(context.available, false);
	assert.equal(context.error, 'no projectRoot given');
});

test('the machine-scope caveat is always present, so the UI cannot omit it', () => {
	const { dir } = makeRepo();
	const context = gitContext({ projectRoot: dir });
	assert.match(context.machineScopeNote, /outside the repo/);
	assert.ok(TRACKED_CONFIG_PATHS.includes('.claude'));
});
