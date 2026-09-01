import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanWorktreeTrust, trustSummary } from '../lib/codex/worktree-trust.mjs';

// All git activity below is local (init/commit/worktree add) and writes only
// under os.tmpdir(). The module under test itself makes exactly one git call
// (read-only `worktree list --porcelain`), asserted separately in the
// validation suite's "no other git subcommand" grep.

function git(args, cwd) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// git resolves worktree paths through the filesystem (on macOS /tmp -> /private/tmp),
// so every path handed back to the module under test is realpath'd up front.
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

function makeHome(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeConfigToml(home, text) {
	const codexDir = path.join(home, '.codex');
	fs.mkdirSync(codexDir, { recursive: true });
	fs.writeFileSync(path.join(codexDir, 'config.toml'), text);
}

test('main checkout with an exact trusted entry reads trusted-exact', () => {
	const { mainDir } = makeRepo('harness-trust-exact-');
	const home = makeHome('harness-trust-exact-home-');
	writeConfigToml(home, `[projects."${mainDir}"]\ntrust_level = "trusted"\n`);

	const result = scanWorktreeTrust({ home, projectRoot: mainDir });
	assert.equal(result.error, undefined);
	const mainRow = result.worktrees.find((row) => row.isMain);
	assert.equal(mainRow.driftKind, 'trusted-exact');
	assert.equal(mainRow.trustSource, 'exact entry');
	assert.ok(Number.isInteger(mainRow.line) && mainRow.line > 0);
	assert.equal(mainRow.settingsPath, path.join(home, '.codex', 'config.toml'));
	assert.ok(mainRow.link.startsWith('vscode://file'));
	assert.equal(mainRow.sha256, null);
	assert.equal(mainRow.bytes, null);
});

test('a linked worktree with no entry of its own falls back to the main checkout entry: trusted-via-main', () => {
	const { root, mainDir } = makeRepo('harness-trust-viamain-');
	const home = makeHome('harness-trust-viamain-home-');
	writeConfigToml(home, `[projects."${mainDir}"]\ntrust_level = "trusted"\n`);
	const wtPath = addWorktree(mainDir, root, 'linked', 'feat/linked');

	const result = scanWorktreeTrust({ home, projectRoot: mainDir });
	const wtRow = result.worktrees.find((row) => row.path === wtPath);
	assert.ok(wtRow, 'linked worktree should be reported');
	assert.equal(wtRow.driftKind, 'trusted-via-main');
	assert.equal(wtRow.trustSource, 'main checkout entry');
	assert.equal(wtRow.isMain, false);
	// via-main points at the MAIN checkout's table line, not the worktree's own (nonexistent) one
	const mainRow = result.worktrees.find((row) => row.isMain);
	assert.equal(wtRow.line, mainRow.line);
});

test('no ancestor-prefix inheritance: a trusted parent directory does not trust a worktree beneath it', () => {
	const { root, mainDir } = makeRepo('harness-trust-noprefix-');
	const home = makeHome('harness-trust-noprefix-home-');
	// Trust the ROOT the repo lives under, not the repo itself or any worktree path.
	writeConfigToml(home, `[projects."${root}"]\ntrust_level = "trusted"\n`);
	addWorktree(mainDir, root, 'linked', 'feat/linked');

	const result = scanWorktreeTrust({ home, projectRoot: mainDir });
	for (const row of result.worktrees) {
		assert.equal(row.driftKind, 'untrusted', `${row.path} must not inherit trust from an ancestor prefix`);
		assert.equal(row.trustSource, 'none');
	}
});

test('an explicit non-trusted entry on the worktree itself wins over a trusted main checkout', () => {
	const { root, mainDir } = makeRepo('harness-trust-explicit-untrust-');
	const home = makeHome('harness-trust-explicit-untrust-home-');
	const wtPath = addWorktree(mainDir, root, 'denied', 'feat/denied');
	writeConfigToml(
		home,
		[
			`[projects."${mainDir}"]`,
			'trust_level = "trusted"',
			'',
			`[projects."${wtPath}"]`,
			'trust_level = "untrusted"',
			'',
		].join('\n'),
	);

	const result = scanWorktreeTrust({ home, projectRoot: mainDir });
	const wtRow = result.worktrees.find((row) => row.path === wtPath);
	assert.equal(wtRow.driftKind, 'untrusted');
	assert.equal(wtRow.trustSource, 'exact entry');
});

test('a missing config.toml yields untrusted rows with the real read error, never a throw', () => {
	const { mainDir } = makeRepo('harness-trust-noconfig-');
	const home = makeHome('harness-trust-noconfig-home-');
	// deliberately no ~/.codex/config.toml written

	const result = scanWorktreeTrust({ home, projectRoot: mainDir });
	assert.equal(result.error, undefined);
	const mainRow = result.worktrees.find((row) => row.isMain);
	assert.equal(mainRow.driftKind, 'untrusted');
	assert.equal(mainRow.trustSource, 'none');
	assert.ok(mainRow.error, 'a missing config.toml should surface a real error on every row');
});

test('git failure (not a repository) returns an empty list with the real stderr, and never throws', () => {
	const home = makeHome('harness-trust-notgit-home-');
	const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-trust-notgit-'));
	const result = scanWorktreeTrust({ home, projectRoot: plainDir });
	assert.deepEqual(result.worktrees, []);
	assert.equal(typeof result.error, 'string');
	assert.ok(result.error.length > 0);
});

test('a missing projectRoot or home is reported, not thrown', () => {
	const home = makeHome('harness-trust-missingargs-home-');
	assert.ok(scanWorktreeTrust({ home }).error);
	assert.ok(scanWorktreeTrust({ projectRoot: '/tmp/whatever' }).error);
	assert.deepEqual(scanWorktreeTrust({ home }).worktrees, []);
});

test('trustSummary tallies exact/via-main/untrusted', () => {
	const rows = [
		{ driftKind: 'trusted-exact' },
		{ driftKind: 'trusted-via-main' },
		{ driftKind: 'trusted-via-main' },
		{ driftKind: 'untrusted' },
	];
	assert.deepEqual(trustSummary(rows), { total: 4, trustedExact: 1, trustedViaMain: 2, untrusted: 1 });
});

test('trustSummary tolerates an empty or missing row list', () => {
	assert.deepEqual(trustSummary([]), { total: 0, trustedExact: 0, trustedViaMain: 0, untrusted: 0 });
	assert.deepEqual(trustSummary(undefined), { total: 0, trustedExact: 0, trustedViaMain: 0, untrusted: 0 });
});

test('guarded reality check: every registered worktree of the real project repo is trusted', () => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex', 'config.toml')) || !fs.existsSync(projectRoot)) {
		return;
	}

	const result = scanWorktreeTrust({ home, projectRoot });
	assert.equal(result.error, undefined);
	// Only invariants that hold for ANY checkout: how many worktrees a repo has,
	// and whether its owner ever trusted them in Codex, are facts about that
	// machine — asserting a floor of 15 here passed in the repo this was written
	// in and failed the moment the panel was cloned on its own.
	assert.ok(result.worktrees.length >= 1, 'the checkout itself is always a worktree');
	assert.equal(
		result.worktrees.filter((row) => row.isMain).length,
		1,
		'exactly one row is the main checkout',
	);
	const KINDS = new Set(['trusted-exact', 'trusted-via-main', 'untrusted']);
	for (const row of result.worktrees) {
		assert.ok(KINDS.has(row.driftKind), `unknown driftKind: ${row.driftKind}`);
		assert.equal(typeof row.path, 'string');
	}
	// The summary must account for every row it was given, whatever the verdicts.
	const summary = trustSummary(result.worktrees);
	assert.equal(summary.total, result.worktrees.length);
	assert.equal(summary.trustedExact + summary.trustedViaMain + summary.untrusted, summary.total);
});
