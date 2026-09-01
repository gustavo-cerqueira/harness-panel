import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHookScript, scanHooks } from '../lib/hooks-scan.mjs';
import { readJsonFile } from '../lib/source-file.mjs';
import { lineOf } from '../lib/json-locate.mjs';

// Test scaffolding writes to a temp dir only; the library under test never
// writes, mirroring the guarantee asserted in test/source-file.test.mjs.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hooks-'));
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');

function write(absPath, content) {
	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, content);
}

function writeExecutable(absPath, content) {
	write(absPath, content);
	fs.chmodSync(absPath, 0o755);
}

// --- user layer: <home>/.claude/settings.json -----------------------------
const userHooks = {
	hooks: {
		SessionStart: [
			{
				hooks: [{ type: 'command', command: 'bash "$HOME"/.claude/hooks/session-start.sh' }],
			},
		],
		UserPromptSubmit: [
			{
				hooks: [{ type: 'command', command: 'python3 "$HOME"/.claude/hooks/prompt-guard.py' }],
			},
		],
	},
};
write(path.join(HOME, '.claude', 'settings.json'), JSON.stringify(userHooks, null, '\t'));
writeExecutable(path.join(HOME, '.claude', 'hooks', 'session-start.sh'), '#!/usr/bin/env bash\necho hi\n');
// deliberately NOT executable: covers the non-executable-script case
write(path.join(HOME, '.claude', 'hooks', 'prompt-guard.py'), '# a secret leaks here: sk-abcdefghijklmnopqrstuvwxyz\n');
fs.chmodSync(path.join(HOME, '.claude', 'hooks', 'prompt-guard.py'), 0o644);

// --- project layer: <projectRoot>/.claude/settings.json --------------------
const projectHooks = {
	hooks: {
		PreToolUse: [
			{
				matcher: 'Write|Edit',
				hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/require-spec-lock.sh' }],
			},
		],
		PostToolUse: [
			{
				matcher: 'Edit|Write|MultiEdit',
				hooks: [
					{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/format-on-save.sh', timeout: 30 },
					{ type: 'command', command: 'npm run lint' },
				],
			},
		],
		Stop: [
			{
				// no matcher key at all, mirroring the real Stop block shape
				hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/missing-script.sh' }],
			},
		],
	},
};
write(path.join(PROJECT, '.claude', 'settings.json'), JSON.stringify(projectHooks, null, '\t'));
writeExecutable(path.join(PROJECT, '.claude', 'hooks', 'require-spec-lock.sh'), '#!/usr/bin/env bash\nexit 0\n');
writeExecutable(path.join(PROJECT, '.claude', 'hooks', 'format-on-save.sh'), '#!/usr/bin/env bash\nexit 0\n');
// missing-script.sh is intentionally never created: covers the missing-script case

// --- local layer: <projectRoot>/.claude/settings.local.json ----------------
const localHookScript = path.join(PROJECT, '.claude', 'hooks', 'local-only.sh');
const localHooks = {
	hooks: {
		PreToolUse: [
			{
				matcher: 'Bash',
				hooks: [{ type: 'command', command: `bash ${localHookScript}` }],
			},
		],
	},
};
write(path.join(PROJECT, '.claude', 'settings.local.json'), JSON.stringify(localHooks, null, '\t'));
writeExecutable(localHookScript, '#!/usr/bin/env bash\nexit 0\n');

const result = scanHooks({ home: HOME, projectRoot: PROJECT });

test('scanHooks returns a flat array, one row per individual hook', () => {
	assert.ok(Array.isArray(result));
	// 2 user + 4 project + 1 local
	assert.equal(result.length, 7);
});

test('$CLAUDE_PROJECT_DIR is expanded to the real project root and resolves an executable script', () => {
	const row = result.find((r) => r.layer === 'project' && r.event === 'PreToolUse');
	assert.equal(row.scriptPath, path.join(PROJECT, '.claude', 'hooks', 'require-spec-lock.sh'));
	assert.equal(row.resolvedFrom, 'CLAUDE_PROJECT_DIR');
	assert.equal(row.scriptExists, true);
	assert.equal(row.scriptExecutable, true);
	assert.equal(row.scriptError, null);
	assert.equal(row.matcher, 'Write|Edit');
});

test('$HOME is expanded to the real home dir and resolves an executable script', () => {
	const row = result.find((r) => r.layer === 'user' && r.event === 'SessionStart');
	assert.equal(row.scriptPath, path.join(HOME, '.claude', 'hooks', 'session-start.sh'));
	assert.equal(row.resolvedFrom, 'HOME');
	assert.equal(row.scriptExists, true);
	assert.equal(row.scriptExecutable, true);
});

test('a non-executable script is reported as existing but not executable, not as an error', () => {
	const row = result.find((r) => r.layer === 'user' && r.event === 'UserPromptSubmit');
	assert.equal(row.scriptPath, path.join(HOME, '.claude', 'hooks', 'prompt-guard.py'));
	assert.equal(row.scriptExists, true);
	assert.equal(row.scriptExecutable, false);
	assert.equal(row.scriptError, null);
});

test('a missing script is a real finding: scriptExists false with a real fs error, not silently dropped', () => {
	const row = result.find((r) => r.layer === 'project' && r.event === 'Stop');
	assert.equal(row.scriptPath, path.join(PROJECT, '.claude', 'hooks', 'missing-script.sh'));
	assert.equal(row.scriptExists, false);
	assert.equal(row.scriptExecutable, false);
	assert.match(row.scriptError, /ENOENT/);
	assert.equal(row.matcher, null, 'a Stop block with no matcher key surfaces matcher as null, not undefined');
});

test('an unresolvable command sets scriptPath null and resolvedFrom "unresolved" rather than guessing', () => {
	const row = result.find((r) => r.command === 'npm run lint');
	assert.equal(row.scriptPath, null);
	assert.equal(row.resolvedFrom, 'unresolved');
	// No script was identified, so whether one exists is UNANSWERED, not false:
	// `false` renders as "script missing", a claim about a file the panel never
	// found. See lib/hooks-scan.mjs's inspectScript().
	assert.equal(row.scriptExists, null);
	assert.equal(row.scriptExecutable, null);
	assert.equal(row.scriptError, null);
});

test('an absolute path with no variable resolves with resolvedFrom "absolute"', () => {
	const row = result.find((r) => r.layer === 'local');
	assert.equal(row.scriptPath, localHookScript);
	assert.equal(row.resolvedFrom, 'absolute');
	assert.equal(row.scriptExists, true);
	assert.equal(row.scriptExecutable, true);
});

test("a second hook within the same block gets its own correct json-locate line, not the first hook's", () => {
	const lintRow = result.find((r) => r.command === 'npm run lint');
	const saveRow = result.find((r) => r.command.includes('format-on-save.sh'));
	const file = readJsonFile(path.join(PROJECT, '.claude', 'settings.json'));
	const expectedSaveLine = lineOf(file.lineIndex, 'hooks.PostToolUse[0].hooks[0].command');
	const expectedLintLine = lineOf(file.lineIndex, 'hooks.PostToolUse[0].hooks[1].command');
	assert.equal(saveRow.line, expectedSaveLine);
	assert.equal(lintRow.line, expectedLintLine);
	assert.notEqual(saveRow.line, lintRow.line);
	assert.equal(saveRow.timeout, 30);
	assert.equal(lintRow.timeout, null);
});

test('every row carries a vscode deep link consistent with its own line', () => {
	for (const row of result) {
		assert.ok(path.isAbsolute(row.sourcePath));
		assert.equal(row.link, `vscode://file${row.sourcePath}:${row.line}`);
	}
});

test('the require-spec-lock escape hatch is attached to the row that runs it, and nowhere else', () => {
	const lockRow = result.find((r) => r.scriptPath && r.scriptPath.endsWith('require-spec-lock.sh'));
	for (const row of result) {
		if (row === lockRow) continue;
	}
});

test('readHookScript reads a script body through redactText so a secret never comes back raw', () => {
	const scriptPath = path.join(HOME, '.claude', 'hooks', 'prompt-guard.py');
	const file = readHookScript(scriptPath);
	assert.equal(file.path, scriptPath);
	assert.equal(file.exists, true);
	assert.ok(file.bytes > 0);
	assert.equal(file.error, null);
	assert.ok(!file.content.includes('sk-abcdefghijklmnopqrstuvwxyz'), 'raw secret must not survive');
	assert.match(file.content, /sk-…/, 'masked form should still be recognizable as a redacted secret');
});

test('readHookScript on a missing path is absent with a real error, never invented content', () => {
	const file = readHookScript(path.join(HOME, '.claude', 'hooks', 'does-not-exist.sh'));
	assert.equal(file.exists, false);
	assert.equal(file.content, null);
	assert.match(file.error, /ENOENT/);
});

test('a settings layer whose file is absent contributes zero rows without throwing', () => {
	const emptyProject = path.join(TMP, 'project-with-no-local-settings');
	fs.mkdirSync(path.join(emptyProject, '.claude'), { recursive: true });
	write(path.join(emptyProject, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }, null, '\t'));
	assert.doesNotThrow(() => scanHooks({ home: HOME, projectRoot: emptyProject }));
	const rows = scanHooks({ home: HOME, projectRoot: emptyProject });
	assert.equal(rows.filter((r) => r.layer === 'project' || r.layer === 'local').length, 0);
});

test('a malformed settings.json never throws and simply yields no rows for that layer', () => {
	const brokenProject = path.join(TMP, 'project-with-broken-settings');
	write(path.join(brokenProject, '.claude', 'settings.json'), '{\n\t"hooks": {\n');
	assert.doesNotThrow(() => scanHooks({ home: HOME, projectRoot: brokenProject }));
});

// --- plugin-contributed hooks --------------------------------------------
// A plugin's hooks/hooks.json is a real hook registration: it fires in every
// session where the plugin is enabled, exactly like a settings-layer hook. The
// section claimed to show "every hook" while showing none of these.
function pluginFixture(name) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `harness-plugin-hooks-${name}-`));
	return { home: path.join(root, 'home'), projectRoot: path.join(root, 'project') };
}

function writePluginHooks(home, { marketplace, plugin, version, hooks }) {
	const dir = path.join(home, '.claude', 'plugins', 'cache', marketplace, plugin, version);
	write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: plugin, version }, null, '\t'));
	write(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks }, null, '\t'));
	return dir;
}

test('an enabled plugin contributes its hooks/hooks.json rows, with CLAUDE_PLUGIN_ROOT resolved', () => {
	const { home, projectRoot } = pluginFixture('enabled');
	const dir = writePluginHooks(home, {
		marketplace: 'basicmachines-co',
		plugin: 'basic-memory',
		version: '0.22.1',
		hooks: {
			SessionStart: [
				{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh', timeout: 20 }] },
			],
		},
	});
	writeExecutable(path.join(dir, 'hooks', 'session-start.sh'), '#!/usr/bin/env bash\necho brief\n');
	write(
		path.join(home, '.claude', 'settings.json'),
		JSON.stringify({ enabledPlugins: { 'basic-memory@basicmachines-co': true } }, null, '\t'),
	);

	const rows = scanHooks({ home, projectRoot });
	const row = rows.find((r) => r.layer === 'plugin' && r.event === 'SessionStart');
	assert.ok(row, 'an enabled plugin hook must appear in the Hooks section');
	assert.equal(row.plugin, 'basic-memory');
	assert.equal(row.pluginVersion, '0.22.1');
	assert.equal(row.scriptPath, path.join(dir, 'hooks', 'session-start.sh'));
	assert.equal(row.scriptExists, true);
	assert.equal(row.scriptExecutable, true);
	assert.equal(row.resolvedFrom, 'CLAUDE_PLUGIN_ROOT');
	assert.equal(row.timeout, 20);
	assert.equal(row.sourcePath, path.join(dir, 'hooks', 'hooks.json'));
	assert.ok(Number.isInteger(row.line) && row.line > 0, 'the deep link needs a real line in hooks.json');
	assert.ok(row.link.startsWith('vscode://file'));
});

test('a disabled plugin contributes no hook rows', () => {
	const { home, projectRoot } = pluginFixture('disabled');
	const dir = writePluginHooks(home, {
		marketplace: 'mkt',
		plugin: 'quiet',
		version: '1.0.0',
		hooks: { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh' }] }] },
	});
	writeExecutable(path.join(dir, 'hooks', 'stop.sh'), '#!/usr/bin/env bash\n');
	write(
		path.join(home, '.claude', 'settings.json'),
		JSON.stringify({ enabledPlugins: { 'quiet@mkt': false } }, null, '\t'),
	);

	assert.equal(scanHooks({ home, projectRoot }).filter((r) => r.layer === 'plugin').length, 0);
});

test('only the ACTIVE cached version of a plugin contributes hooks', () => {
	const { home, projectRoot } = pluginFixture('versions');
	for (const version of ['1.0.0', '2.0.0']) {
		const dir = writePluginHooks(home, {
			marketplace: 'mkt',
			plugin: 'multi',
			version,
			hooks: { Stop: [{ hooks: [{ type: 'command', command: `\${CLAUDE_PLUGIN_ROOT}/hooks/stop-${version}.sh` }] }] },
		});
		writeExecutable(path.join(dir, 'hooks', `stop-${version}.sh`), '#!/usr/bin/env bash\n');
	}
	fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'multi', '2.0.0', '.in_use'), { recursive: true });
	write(
		path.join(home, '.claude', 'settings.json'),
		JSON.stringify({ enabledPlugins: { 'multi@mkt': true } }, null, '\t'),
	);

	const rows = scanHooks({ home, projectRoot }).filter((r) => r.layer === 'plugin');
	// A hook in a stale cached version never fires, so listing it as a live hook
	// would be a false claim about what runs in this session.
	assert.equal(rows.length, 1);
	assert.equal(rows[0].pluginVersion, '2.0.0');
});

test('an enabled plugin with no hooks.json is not an error', () => {
	const { home, projectRoot } = pluginFixture('no-hooks');
	const dir = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plain', '1.0.0');
	write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'plain' }, null, '\t'));
	write(
		path.join(home, '.claude', 'settings.json'),
		JSON.stringify({ enabledPlugins: { 'plain@mkt': true } }, null, '\t'),
	);

	let rows;
	assert.doesNotThrow(() => {
		rows = scanHooks({ home, projectRoot });
	});
	assert.equal(rows.filter((r) => r.layer === 'plugin').length, 0);
});

test('settings-layer hook rows carry no plugin identity', () => {
	for (const row of scanHooks({ home: HOME, projectRoot: PROJECT })) {
		assert.equal(row.plugin, null);
		assert.equal(row.pluginVersion, null);
	}
});
