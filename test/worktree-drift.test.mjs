import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { driftSummary, scanWorktreeDrift } from '../lib/worktree-drift.mjs';

// All git activity below is local (init/commit/worktree add) and writes only
// under os.tmpdir(). The module under test itself never runs a write-capable
// git subcommand — that is asserted separately by the "read only" grep in the
// validation suite. This scaffolding is the exception the brief allows.

function git(args, cwd) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// git resolves every worktree path through the filesystem (on macOS this
// means /tmp -> /private/tmp), so every path this scaffolding hands back is
// realpath'd up front. Comparing anything else against `result.worktrees[].path`
// would be comparing two different spellings of the same directory.
function makeRepo(prefix) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	const mainDir = path.join(root, 'main');
	fs.mkdirSync(mainDir);
	git(['init', '-q', '-b', 'trunk'], mainDir);
	git(
		['-c', 'user.email=harness@example.com', '-c', 'user.name=Harness', 'commit', '--allow-empty', '-q', '-m', 'init'],
		mainDir,
	);
	return { root, mainDir };
}

function addWorktree(mainDir, root, name, branch) {
	const wtPath = path.join(root, name);
	git(['worktree', 'add', '-q', wtPath, '-b', branch], mainDir);
	return fs.realpathSync(wtPath);
}

function writeSettings(worktreeDir, content) {
	const claudeDir = path.join(worktreeDir, '.claude');
	fs.mkdirSync(claudeDir, { recursive: true });
	fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), content);
}

test('identical settings across worktrees are reported as same, not drifted', () => {
	const { root, mainDir } = makeRepo('harness-drift-same-');
	writeSettings(mainDir, '{"model":"opus"}\n');
	const wtPath = addWorktree(mainDir, root, 'same', 'feat/same');
	writeSettings(wtPath, '{"model":"opus"}\n');

	const result = scanWorktreeDrift({ projectRoot: mainDir });
	assert.equal(result.error, undefined);

	const mainRow = result.worktrees.find((row) => row.isMain);
	const wtRow = result.worktrees.find((row) => row.path !== mainRow.path);

	assert.equal(mainRow.driftKind, 'same');
	assert.equal(mainRow.drifted, false);
	assert.ok(mainRow.sha256);

	assert.equal(wtRow.exists, true);
	assert.equal(wtRow.sha256, mainRow.sha256);
	assert.equal(wtRow.driftKind, 'same');
	assert.equal(wtRow.drifted, false);
});

test('different settings content is flagged as different, not missing', () => {
	const { root, mainDir } = makeRepo('harness-drift-diff-');
	writeSettings(mainDir, '{"model":"opus"}\n');
	const wtPath = addWorktree(mainDir, root, 'diff', 'feat/diff');
	writeSettings(wtPath, '{"model":"sonnet"}\n');

	const result = scanWorktreeDrift({ projectRoot: mainDir });
	const mainRow = result.worktrees.find((row) => row.isMain);
	const wtRow = result.worktrees.find((row) => row.path !== mainRow.path);

	assert.equal(wtRow.exists, true);
	assert.notEqual(wtRow.sha256, mainRow.sha256);
	assert.equal(wtRow.driftKind, 'different');
	assert.equal(wtRow.drifted, true);
});

test('a worktree missing its settings file entirely is missing-here, never confused with different', () => {
	const { root, mainDir } = makeRepo('harness-drift-here-');
	writeSettings(mainDir, '{"model":"opus"}\n');
	const wtPath = addWorktree(mainDir, root, 'nofile', 'feat/nofile');
	// deliberately no .claude directory in this worktree

	const result = scanWorktreeDrift({ projectRoot: mainDir });
	const wtRow = result.worktrees.find((row) => row.path === wtPath);

	assert.equal(wtRow.exists, false);
	assert.equal(wtRow.sha256, null);
	assert.equal(wtRow.bytes, null);
	assert.equal(wtRow.driftKind, 'missing-here');
	assert.equal(wtRow.drifted, true);
	assert.match(wtRow.error, /ENOENT/);
});

test('a settings file present in a worktree but absent from main is missing-in-main', () => {
	const { root, mainDir } = makeRepo('harness-drift-main-');
	// main deliberately has no settings.local.json at all
	const wtWithFile = addWorktree(mainDir, root, 'hasfile', 'feat/hasfile');
	writeSettings(wtWithFile, '{"model":"opus"}\n');
	const wtWithout = addWorktree(mainDir, root, 'alsonone', 'feat/alsonone');

	const result = scanWorktreeDrift({ projectRoot: mainDir });
	const mainRow = result.worktrees.find((row) => row.isMain);
	const withFileRow = result.worktrees.find((row) => row.path === wtWithFile);
	const withoutRow = result.worktrees.find((row) => row.path === wtWithout);

	assert.equal(mainRow.exists, false);
	assert.equal(mainRow.driftKind, 'same'); // trivially equal to itself
	assert.equal(mainRow.drifted, false);

	assert.equal(withFileRow.exists, true);
	assert.equal(withFileRow.driftKind, 'missing-in-main');
	assert.equal(withFileRow.drifted, true);

	// both absent is a consistent state, not a drift
	assert.equal(withoutRow.exists, false);
	assert.equal(withoutRow.driftKind, 'same');
	assert.equal(withoutRow.drifted, false);
});

test('a settings path that is a directory instead of a file is reported unknown, never coerced into a hash', () => {
	const { root, mainDir } = makeRepo('harness-drift-dircollide-');
	writeSettings(mainDir, '{"model":"opus"}\n');
	const wtPath = addWorktree(mainDir, root, 'dircollide', 'feat/dircollide');
	// settings.local.json exists but as a directory, not a file
	fs.mkdirSync(path.join(wtPath, '.claude', 'settings.local.json'), { recursive: true });

	const result = scanWorktreeDrift({ projectRoot: mainDir });
	const wtRow = result.worktrees.find((row) => row.path === wtPath);

	assert.equal(wtRow.driftKind, 'unknown');
	assert.ok(wtRow.error);
});

test('git failure (not a repository) returns an empty list with the real stderr, and never throws', () => {
	const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-drift-notgit-'));
	const result = scanWorktreeDrift({ projectRoot: plainDir });
	assert.deepEqual(result.worktrees, []);
	assert.equal(typeof result.error, 'string');
	assert.ok(result.error.length > 0);
});

test('a missing projectRoot is reported, not thrown', () => {
	const result = scanWorktreeDrift({});
	assert.deepEqual(result.worktrees, []);
	assert.ok(result.error);
});

test('branch, head and link fields carry real git values, not placeholders', () => {
	const { mainDir } = makeRepo('harness-drift-fields-');
	writeSettings(mainDir, '{"model":"opus"}\n');
	const result = scanWorktreeDrift({ projectRoot: mainDir });
	const mainRow = result.worktrees.find((row) => row.isMain);

	assert.match(mainRow.branch, /^refs\/heads\/trunk$/);
	assert.match(mainRow.head, /^[0-9a-f]{40}$/);
	assert.equal(mainRow.settingsPath, path.join(mainDir, '.claude', 'settings.local.json'));
	assert.ok(mainRow.link.startsWith('vscode://file'));
	assert.ok(mainRow.link.includes(mainRow.settingsPath));
});

test('driftSummary tallies same/different/missing and captures the main sha256', () => {
	const rows = [
		{ isMain: true, driftKind: 'same', sha256: 'main-sha' },
		{ isMain: false, driftKind: 'same', sha256: 'main-sha' },
		{ isMain: false, driftKind: 'different', sha256: 'other-sha' },
		{ isMain: false, driftKind: 'missing-here', sha256: null },
		{ isMain: false, driftKind: 'missing-in-main', sha256: 'yet-another' },
		{ isMain: false, driftKind: 'unknown', sha256: null },
	];
	const summary = driftSummary(rows);
	assert.equal(summary.total, 6);
	assert.equal(summary.same, 2);
	assert.equal(summary.different, 1);
	assert.equal(summary.missing, 2);
	assert.equal(summary.mainSha256, 'main-sha');
});

test('driftSummary tolerates an empty or missing row list', () => {
	assert.deepEqual(driftSummary([]), { total: 0, same: 0, different: 0, missing: 0, mainSha256: null });
	assert.deepEqual(driftSummary(undefined), { total: 0, same: 0, different: 0, missing: 0, mainSha256: null });
});
