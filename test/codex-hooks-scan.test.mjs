import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
	CODEX_KNOWN_ESCAPE_HATCHES,
	computeHookTrustHash,
	hookTrustKey,
	readHookScript,
	scanCodexHooks,
	snakeCaseEvent,
} from '../lib/codex/hooks-scan.mjs';

function tmpRoot(tag) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `harness-codex-hooks-${tag}-`));
}

function write(absPath, content, mode) {
	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, content);
	if (mode !== undefined) fs.chmodSync(absPath, mode);
}

/**
 * Fixed vectors shaped like hooks a real Codex install approves, with paths
 * genericized and the digests recomputed by `computeHookTrustHash` itself for
 * that genericized input. They pin the canonicalization independently of the
 * scanner: if the normalization ever drifts, these fail even when every
 * fixture still agrees with itself.
 */
const SESSION_START_VECTOR = {
	event: 'SessionStart',
	matcher: null,
	handler: {
		type: 'command',
		command: "python3 '/Users/me/.codex/hooks/basic-memory-brief.py'",
		timeout: 20,
		statusMessage: 'Briefing from Basic Memory',
	},
	canonical:
		'{"event_name":"session_start","hooks":[{"async":false,"command":"python3 ' +
		'\'/Users/me/.codex/hooks/basic-memory-brief.py\'","statusMessage":"Briefing from Basic Memory",' +
		'"timeout":20,"type":"command"}]}',
	hash: 'sha256:a2edfcaab5c41baa8fccdc6ad447439e51d30ee9bbbaac2e43003e736b04012c',
};

const IMPECCABLE_COMMAND =
	'[ ! -f "/Users/me/.agents/skills/impeccable/scripts/hook.mjs" ] || ' +
	'node "/Users/me/.agents/skills/impeccable/scripts/hook.mjs"';

const POST_TOOL_USE_VECTOR = {
	event: 'PostToolUse',
	matcher: 'Edit|Write|apply_patch',
	handler: { type: 'command', command: IMPECCABLE_COMMAND, timeout: 5, statusMessage: 'Checking UI changes' },
	hash: 'sha256:39aa9fd88afb2f2567ee511ec80115f18a0ad8d609c7e26543f1e38e2eec192e',
};

const PRE_TOOL_USE_VECTOR = {
	event: 'PreToolUse',
	matcher: 'Write',
	handler: {
		type: 'command',
		command: "bash '/Users/me/projects/demo/.codex/hooks/block-apps-barrel-export.sh'",
		statusMessage: 'Checking No Barrel Exports policy...',
	},
	hash: 'sha256:a35329cdbda44d09b0f01078beb26521596b07c576c0b24e5a2823479dd3b54f',
};

test('fixed vector: the SessionStart hook Codex approved reproduces byte for byte', () => {
	const result = computeHookTrustHash(SESSION_START_VECTOR);
	assert.equal(result.canonical, SESSION_START_VECTOR.canonical);
	assert.equal(result.hash, SESSION_START_VECTOR.hash);
});

test('fixed vector: a matcher event hashes WITH its matcher inside the identity', () => {
	const result = computeHookTrustHash(POST_TOOL_USE_VECTOR);
	assert.equal(result.hash, POST_TOOL_USE_VECTOR.hash);
	assert.match(result.canonical, /"matcher":"Edit\|Write\|apply_patch"/);

	// Same handler without the matcher is a different hook, and must not collide.
	const withoutMatcher = computeHookTrustHash({ ...POST_TOOL_USE_VECTOR, matcher: null });
	assert.notEqual(withoutMatcher.hash, POST_TOOL_USE_VECTOR.hash);
});

test('fixed vector: an undeclared timeout is hashed as Codex default 600', () => {
	const result = computeHookTrustHash(PRE_TOOL_USE_VECTOR);
	assert.equal(result.hash, PRE_TOOL_USE_VECTOR.hash);
	assert.match(result.canonical, /"timeout":600/);
});

test('a matcher declared on an event that has none is left out of the identity', () => {
	const handler = { type: 'command', command: '/bin/true' };
	const withStrayMatcher = computeHookTrustHash({ event: 'Stop', matcher: 'Edit', handler });
	const bare = computeHookTrustHash({ event: 'Stop', matcher: null, handler });
	assert.equal(withStrayMatcher.hash, bare.hash);
	assert.doesNotMatch(withStrayMatcher.canonical, /matcher/);
});

test('SessionEnd defaults to 1 second and is capped at 3', () => {
	const handler = { type: 'command', command: '/bin/true' };
	assert.match(computeHookTrustHash({ event: 'SessionEnd', matcher: null, handler }).canonical, /"timeout":1/);
	assert.match(
		computeHookTrustHash({ event: 'SessionEnd', matcher: null, handler: { ...handler, timeout: 90 } }).canonical,
		/"timeout":3/,
	);
});

test('a handler with no command cannot be hashed, so it cannot be trusted', () => {
	const result = computeHookTrustHash({ event: 'Stop', matcher: null, handler: { type: 'command', command: '' } });
	assert.equal(result.hash, null);
	assert.match(result.reason, /no command/);
});

test('the trust key is the source path, the snake_case event, and both indexes', () => {
	assert.equal(snakeCaseEvent('UserPromptSubmit'), 'user_prompt_submit');
	assert.equal(snakeCaseEvent('PreToolUse'), 'pre_tool_use');
	assert.equal(hookTrustKey('/a/hooks.json', 'PostToolUse', 2, 0), '/a/hooks.json:post_tool_use:2:0');
});

/**
 * Two layers of declarations plus a config.toml whose trust state is generated
 * from the SAME canonicalization the scanner uses — so this fixture proves the
 * plumbing (key format, lookup, comparison, per-row reporting) while the fixed
 * vectors above prove the canonicalization itself.
 */
function fixture(tag, { tamper = false, recordTrust = true } = {}) {
	const home = tmpRoot(`${tag}-home`);
	const projectRoot = tmpRoot(`${tag}-repo`);
	const codexHome = path.join(home, '.codex');

	const userScript = path.join(codexHome, 'hooks', 'brief.py');
	const projectScript = path.join(projectRoot, '.codex', 'hooks', 'gate.sh');
	write(userScript, '#!/usr/bin/env python3\nprint("brief")\n', 0o644);
	write(projectScript, '#!/usr/bin/env bash\nexit 0\n', 0o755);

	const userHooks = {
		hooks: {
			SessionStart: [
				{ hooks: [{ type: 'command', command: `python3 '${userScript}'`, timeout: 20, statusMessage: 'Brief' }] },
			],
			PostToolUse: [
				{
					matcher: 'Edit|Write',
					hooks: [
						{ type: 'command', command: `python3 '${userScript}'`, timeout: 5 },
						{ type: 'command', command: 'echo second-handler-in-the-same-group' },
					],
				},
			],
		},
	};
	const projectHooks = {
		hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `bash '${projectScript}'` }] }] },
	};

	const userHooksPath = path.join(codexHome, 'hooks.json');
	const projectHooksPath = path.join(projectRoot, '.codex', 'hooks.json');
	write(userHooksPath, JSON.stringify(userHooks, null, 2));
	write(projectHooksPath, JSON.stringify(projectHooks, null, 2));

	const stateLines = [];
	if (recordTrust) {
		const record = (sourcePath, event, groupIndex, hookIndex, matcher, handler) => {
			const { hash } = computeHookTrustHash({ event, matcher, handler });
			stateLines.push(
				`[hooks.state."${hookTrustKey(sourcePath, event, groupIndex, hookIndex)}"]`,
				`trusted_hash = "${hash}"`,
				'',
			);
		};
		record(userHooksPath, 'SessionStart', 0, 0, null, userHooks.hooks.SessionStart[0].hooks[0]);
		record(userHooksPath, 'PostToolUse', 0, 0, 'Edit|Write', userHooks.hooks.PostToolUse[0].hooks[0]);
		record(userHooksPath, 'PostToolUse', 0, 1, 'Edit|Write', userHooks.hooks.PostToolUse[0].hooks[1]);
		record(projectHooksPath, 'PreToolUse', 0, 0, 'Write', projectHooks.hooks.PreToolUse[0].hooks[0]);
	}
	write(path.join(codexHome, 'config.toml'), ['model = "gpt-fixture"', '', ...stateLines].join('\n'));

	if (tamper) {
		// Approve, then edit: exactly the drift the trusted_hash exists to catch.
		userHooks.hooks.SessionStart[0].hooks[0].command = `python3 '${userScript}' --now-with-an-extra-flag`;
		write(userHooksPath, JSON.stringify(userHooks, null, 2));
	}

	return { home, projectRoot, codexHome, userHooksPath, projectHooksPath, userScript, projectScript };
}

const rowFor = (rows, event, index = 0) => rows.filter((row) => row.event === event)[index];

test('every declared handler becomes a row that deep-links to its own line', () => {
	const f = fixture('rows');
	const rows = scanCodexHooks({ home: f.home, projectRoot: f.projectRoot, codexHome: f.codexHome });

	assert.equal(rows.length, 4, 'three user handlers (two of them in one group) plus one project handler');
	assert.deepEqual(
		rows.map((row) => `${row.layer}:${row.event}:${row.groupIndex}:${row.hookIndex}`),
		['user:SessionStart:0:0', 'user:PostToolUse:0:0', 'user:PostToolUse:0:1', 'project:PreToolUse:0:0'],
	);

	const sessionStart = rowFor(rows, 'SessionStart');
	assert.equal(sessionStart.sourcePath, f.userHooksPath);
	assert.equal(sessionStart.type, 'command');
	assert.equal(sessionStart.matcher, null);
	assert.equal(sessionStart.timeout, 20);
	assert.equal(sessionStart.statusMessage, 'Brief');
	assert.equal(sessionStart.async, false);
	assert.equal(sessionStart.eventKnown, true);
	assert.ok(sessionStart.line > 1, 'expected a real line number out of the JSON index');
	assert.equal(sessionStart.link, `vscode://file${f.userHooksPath}:${sessionStart.line}`);
	assert.equal(sessionStart.scriptPath, f.userScript);
	assert.equal(sessionStart.scriptExists, true);
	assert.equal(sessionStart.scriptExecutable, false, 'mode 644, and the command runs it through python3');
	assert.equal(sessionStart.scriptError, null);

	const project = rowFor(rows, 'PreToolUse');
	assert.equal(project.layer, 'project');
	assert.equal(project.matcher, 'Write');
	// Undeclared timeout: the declaration is honestly null, the enforced value is the default.
	assert.equal(project.timeout, null);
	assert.equal(project.effectiveTimeout, 600);
	assert.equal(project.scriptExecutable, true);
});

test('a hook whose recorded hash matches is trusted, and says so', () => {
	const f = fixture('trusted');
	const rows = scanCodexHooks({ home: f.home, projectRoot: f.projectRoot, codexHome: f.codexHome });

	for (const row of rows) {
		assert.equal(row.trusted, true, `${row.trustKey} should be trusted`);
		assert.equal(row.trustedHash, row.expectedHash);
		assert.equal(row.trustedHashPath, path.join(f.codexHome, 'config.toml'));
		assert.ok(row.trustedHashLine > 1, 'expected the config.toml line that records the hash');
		assert.equal(row.trustedHashLink, `vscode://file${row.trustedHashPath}:${row.trustedHashLine}`);
		assert.match(row.trustNote, /will run this hook/);
		assert.equal(row.escapeHatches.includes('untrusted-hook-silently-skipped'), false);
	}
});

test('editing an approved hook makes it untrusted, which is the finding that matters', () => {
	const f = fixture('tampered', { tamper: true });
	const rows = scanCodexHooks({ home: f.home, projectRoot: f.projectRoot, codexHome: f.codexHome });

	const edited = rowFor(rows, 'SessionStart');
	assert.equal(edited.trusted, false);
	assert.notEqual(edited.expectedHash, edited.trustedHash);
	assert.ok(edited.trustedHash, 'the stale recorded hash is still reported, not hidden');
	assert.match(edited.trustNote, /re-approved through \/hooks/);
	assert.ok(edited.escapeHatches.includes('untrusted-hook-silently-skipped'));

	// The hooks that were not touched are unaffected.
	assert.equal(rowFor(rows, 'PreToolUse').trusted, true);
});

test('a hook with no recorded hash at all is untrusted, not unknown', () => {
	const f = fixture('unrecorded', { recordTrust: false });
	const rows = scanCodexHooks({ home: f.home, projectRoot: f.projectRoot, codexHome: f.codexHome });

	for (const row of rows) {
		assert.equal(row.trusted, false);
		assert.equal(row.trustedHash, null);
		assert.ok(row.expectedHash.startsWith('sha256:'));
		assert.match(row.trustNote, /approved through \/hooks/);
	}
});

test('an unreadable config.toml leaves trust null rather than accusing every hook', () => {
	const f = fixture('noconfig', { recordTrust: false });
	fs.rmSync(path.join(f.codexHome, 'config.toml'));

	const rows = scanCodexHooks({ home: f.home, projectRoot: f.projectRoot, codexHome: f.codexHome });
	for (const row of rows) {
		assert.equal(row.trusted, null);
		assert.match(row.trustNote, /Trust state unreadable/);
	}
});

test('trust readability is per source: a readable project config judges project rows even when the user config is absent', () => {
	const home = tmpRoot('project-only-trust-home');
	const projectRoot = tmpRoot('project-only-trust-repo');
	const codexHome = path.join(home, '.codex');
	// Deliberately NO ~/.codex/config.toml at all.

	const userScript = path.join(codexHome, 'hooks', 'brief.py');
	const projectScript = path.join(projectRoot, '.codex', 'hooks', 'gate.sh');
	write(userScript, '#!/usr/bin/env python3\nprint("brief")\n', 0o644);
	write(projectScript, '#!/usr/bin/env bash\nexit 0\n', 0o755);

	const userHooksPath = path.join(codexHome, 'hooks.json');
	write(
		userHooksPath,
		JSON.stringify({
			hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `python3 '${userScript}'`, timeout: 20 }] }] },
		}),
	);

	const projectHooksPath = path.join(projectRoot, '.codex', 'hooks.json');
	const preToolUse = { type: 'command', command: `bash '${projectScript}'` };
	write(projectHooksPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [preToolUse] }] } }));

	// Only the PROJECT config.toml records trust, and it is readable.
	const { hash } = computeHookTrustHash({ event: 'PreToolUse', matcher: 'Write', handler: preToolUse });
	write(
		path.join(projectRoot, '.codex', 'config.toml'),
		[
			'model = "gpt-fixture"',
			'',
			`[hooks.state."${hookTrustKey(projectHooksPath, 'PreToolUse', 0, 0)}"]`,
			`trusted_hash = "${hash}"`,
			'',
		].join('\n'),
	);

	const rows = scanCodexHooks({ home, projectRoot, codexHome });

	const project = rowFor(rows, 'PreToolUse');
	assert.equal(project.trusted, true, 'the project hook was judged using the readable project config');
	assert.equal(project.trustedHash, hash);

	// The user hook has no state anywhere it could be recorded -- this is a
	// verdict (untrusted), not an "unreadable" abstention, because at least one
	// trust-state source (the project config) was readable.
	const userRow = rowFor(rows, 'SessionStart');
	assert.equal(userRow.trusted, false);
	assert.doesNotMatch(userRow.trustNote, /unreadable/i);
	assert.match(userRow.trustNote, /No trusted_hash recorded/);
});

test('a missing script and an unresolvable command are told apart', () => {
	const home = tmpRoot('paths-home');
	const projectRoot = tmpRoot('paths-repo');
	const codexHome = path.join(home, '.codex');
	write(
		path.join(codexHome, 'hooks.json'),
		JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: 'command', command: `bash '${path.join(codexHome, 'hooks', 'gone.sh')}'` }] }],
				SessionEnd: [{ hooks: [{ type: 'command', command: 'echo just-an-inline-command' }] }],
				NotAnEvent: [{ hooks: [{ type: 'command', command: '/bin/true' }] }],
			},
		}),
	);
	write(path.join(codexHome, 'config.toml'), 'model = "x"\n');

	const rows = scanCodexHooks({ home, projectRoot, codexHome });
	const missing = rowFor(rows, 'Stop');
	assert.equal(missing.scriptExists, false);
	assert.ok(missing.scriptError, 'a vanished script reports the real stat error');

	const inline = rowFor(rows, 'SessionEnd');
	assert.equal(inline.scriptPath, null);
	assert.equal(inline.resolvedFrom, 'unresolved');
	assert.equal(inline.scriptError, null);
	assert.equal(inline.effectiveTimeout, 1);

	// A typo in the event name is a finding, not a row to hide.
	const unknown = rowFor(rows, 'NotAnEvent');
	assert.ok(unknown, 'expected an unrecognised event to still produce a row');
	assert.equal(unknown.eventKnown, false);
});

test('$HOME and $CODEX_HOME are expanded; an unknown variable stays unresolved', () => {
	const home = tmpRoot('vars-home');
	const projectRoot = tmpRoot('vars-repo');
	const codexHome = path.join(home, '.codex');
	write(path.join(codexHome, 'hooks', 'v.sh'), '#!/bin/sh\n', 0o755);
	write(
		path.join(codexHome, 'hooks.json'),
		JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: 'command', command: 'bash "$CODEX_HOME"/hooks/v.sh' }] }],
				SessionStart: [{ hooks: [{ type: 'command', command: 'bash "$SOMETHING_ELSE"/hooks/v.sh' }] }],
			},
		}),
	);
	write(path.join(codexHome, 'config.toml'), 'model = "x"\n');

	const rows = scanCodexHooks({ home, projectRoot, codexHome });
	assert.equal(rowFor(rows, 'Stop').scriptPath, path.join(codexHome, 'hooks', 'v.sh'));
	assert.equal(rowFor(rows, 'Stop').resolvedFrom, 'CODEX_HOME');
	assert.equal(rowFor(rows, 'SessionStart').scriptPath, null);
	assert.equal(rowFor(rows, 'SessionStart').resolvedFrom, 'unresolved');
});

test('an enabled plugin contributes rows; a disabled one contributes nothing', () => {
	const home = tmpRoot('plugins-home');
	const projectRoot = tmpRoot('plugins-repo');
	const codexHome = path.join(home, '.codex');
	const cache = path.join(codexHome, 'plugins', 'cache');

	const onDoc = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo on' }] }] } };
	const offDoc = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo off' }] }] } };
	write(path.join(cache, 'market', 'on-plugin', '1.0.0', 'hooks', 'hooks.json'), JSON.stringify(onDoc, null, 2));
	write(path.join(cache, 'market', 'off-plugin', '1.0.0', '.codex', 'hooks.json'), JSON.stringify(offDoc, null, 2));
	write(
		path.join(codexHome, 'config.toml'),
		[
			'model = "x"',
			'',
			'[plugins."on-plugin@market"]',
			'enabled = true',
			'',
			'[plugins."off-plugin@market"]',
			'enabled = false',
			'',
		].join('\n'),
	);

	const rows = scanCodexHooks({ home, projectRoot, codexHome });
	const pluginRows = rows.filter((row) => row.layer === 'plugin');
	assert.equal(pluginRows.length, 1);
	assert.equal(pluginRows[0].command, 'echo on');
	// Trust for plugin manifests is unverified, so it is not claimed either way.
	assert.equal(pluginRows[0].trusted, null);
	assert.match(pluginRows[0].trustNote, /unverified/);
	assert.match(pluginRows[0].note, /on-plugin@market/);
});

test('a linked worktree reads the main checkout’s declarations, and says so', (t) => {
	const parent = tmpRoot('worktree');
	const mainRepo = path.join(parent, 'main');
	const linked = path.join(parent, 'linked');
	const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		fs.mkdirSync(mainRepo, { recursive: true });
		git(['init', '-b', 'main'], mainRepo);
		git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], mainRepo);
		git(['worktree', 'add', linked, '-b', 'feat/x'], mainRepo);
	} catch (error) {
		t.skip(`git unavailable: ${String(error?.message || error)}`);
		return;
	}

	const home = tmpRoot('worktree-home');
	const codexHome = path.join(home, '.codex');
	write(path.join(codexHome, 'config.toml'), 'model = "x"\n');
	const mainHooks = path.join(mainRepo, '.codex', 'hooks.json');
	write(mainHooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo from-main' }] }] } }));

	// git answers with the REAL path (on macOS /var is a symlink to /private/var),
	// and git's answer is the one Codex keys its trust state under, so that is
	// what the row must carry.
	const expectedSource = path.join(fs.realpathSync(mainRepo), '.codex', 'hooks.json');

	const rows = scanCodexHooks({ home, projectRoot: linked, codexHome }).filter((row) => row.layer === 'project');
	assert.equal(rows.length, 1);
	assert.equal(rows[0].sourcePath, expectedSource);
	assert.match(rows[0].note, /linked worktree/);
	// The trust key names the main checkout, which is why substitution matters.
	assert.equal(rows[0].trustKey, `${expectedSource}:stop:0:0`);
});

test('readHookScript returns the body with secrets redacted', () => {
	const dir = tmpRoot('script');
	const script = path.join(dir, 'leaky.sh');
	write(script, '#!/bin/sh\nexport TOKEN=sk-abcdefghijklmnopqrstuvwxyz0123\necho ok\n');

	const result = readHookScript(script);
	assert.equal(result.exists, true);
	assert.doesNotMatch(result.content, /sk-abcdefghijklmnopqrstuvwxyz0123/);
	assert.match(result.content, /echo ok/);
	assert.equal(readHookScript(path.join(dir, 'missing.sh')).exists, false);
	assert.equal(readHookScript(dir).error, 'path is a directory, not a file');
});

test('the escape-hatch catalogue is exported for the UI, independent of any scan', () => {
	const ids = CODEX_KNOWN_ESCAPE_HATCHES.map((entry) => entry.id);
	assert.ok(ids.includes('untrusted-hook-silently-skipped'));
	assert.ok(ids.includes('codex-hooks-tool-scoped'));
	for (const entry of CODEX_KNOWN_ESCAPE_HATCHES) {
		assert.equal(typeof entry.title, 'string');
		assert.equal(typeof entry.detail, 'string');
		assert.ok(Array.isArray(entry.appliesTo));
	}
});

test('guarded reality check: every hook this machine approved reproduces its recorded hash', (t) => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	const realCodexHome = process.env.CODEX_HOME || path.join(home, '.codex');
	if (
		!fs.existsSync(path.join(realCodexHome, 'hooks.json')) ||
		!fs.existsSync(path.join(projectRoot, '.codex', 'hooks.json'))
	) {
		t.skip('no real Codex hooks on this machine');
		return;
	}

	const rows = scanCodexHooks({ home, projectRoot });
	const declared = rows.filter((row) => row.layer === 'user' || row.layer === 'project');
	assert.equal(declared.length, 8, `expected 8 declared hooks (4 user + 4 project), got ${declared.length}`);
	assert.equal(declared.filter((row) => row.layer === 'user').length, 4);
	assert.equal(declared.filter((row) => row.layer === 'project').length, 4);

	for (const row of declared) {
		assert.equal(
			row.trusted,
			true,
			`${row.trustKey}\n  recorded ${row.trustedHash}\n  computed ${row.expectedHash}\n  ` +
				'a mismatch here means this scanner normalizes differently from Codex, not that the hook is stale',
		);
		assert.ok(row.line >= 1);
		assert.ok(row.command && row.command.length > 0);
	}
});
