import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KNOWN_SETTING_KEYS, mergeSettings } from '../lib/settings-merge.mjs';

const ENTERPRISE_PATH = '/Library/Application Support/ClaudeCode/managed-settings.json';

/**
 * Builds a throwaway home + project pair under os.tmpdir().
 *
 * `files` maps a slot name to raw file TEXT (not an object) so the fixtures can
 * carry exact line numbers and deliberately malformed JSON.
 */
function fixture(t, files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-settings-merge-'));
	const home = path.join(root, 'home');
	const projectRoot = path.join(root, 'repo');
	const slots = {
		userSettings: path.join(home, '.claude', 'settings.json'),
		userSettingsLocal: path.join(home, '.claude', 'settings.local.json'),
		projectSettings: path.join(projectRoot, '.claude', 'settings.json'),
		localSettings: path.join(projectRoot, '.claude', 'settings.local.json'),
	};
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

	for (const [slot, text] of Object.entries(files)) {
		const target = slots[slot];
		assert.ok(target, `unknown fixture slot ${slot}`);
		fs.writeFileSync(target, text, 'utf8');
	}

	t.after(() => {
		// Guarded so a bad path can never delete anything outside the temp dir.
		if (root.startsWith(os.tmpdir()) && root.includes('ez-settings-merge-')) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	return { home, projectRoot, slots };
}

const json = (value) => `${JSON.stringify(value, null, '\t')}\n`;

function keyOf(result, key) {
	const found = result.keys.find((entry) => entry.key === key);
	assert.ok(found, `expected key ${key} in ${result.keys.map((k) => k.key).join(', ')}`);
	return found;
}

function entryOf(keyRow, layer) {
	const found = keyRow.perLayer.find((entry) => entry.layer === layer);
	assert.ok(found, `expected layer ${layer} on key ${keyRow.key}`);
	return found;
}

test('local beats project beats user for an ordinary key', (t) => {
	const { home, projectRoot, slots } = fixture(t, {
		userSettings: json({ model: 'opus', theme: 'dark' }),
		projectSettings: json({ model: 'sonnet' }),
		localSettings: json({ model: 'haiku' }),
	});

	const result = mergeSettings({ home, projectRoot });
	const model = keyOf(result, 'model');

	assert.equal(model.effectiveValue, 'haiku');
	assert.equal(model.winningLayer, 'local');
	assert.equal(model.known, true);
	assert.equal(model.secret, false);
	assert.equal(model.ownerOnly, false);

	assert.equal(entryOf(model, 'user').overridden, true);
	assert.equal(entryOf(model, 'project').overridden, true);
	assert.equal(entryOf(model, 'local').overridden, false);
	assert.equal(entryOf(model, 'local').path, slots.localSettings);
	assert.equal(entryOf(model, 'user').ignored, false);

	// Every layer entry keeps a jump-to-source link at the right line.
	assert.equal(entryOf(model, 'project').line, 2);
	assert.equal(entryOf(model, 'project').link, `vscode://file${slots.projectSettings}:2`);

	// A key only one layer sets is not a conflict.
	assert.equal(keyOf(result, 'theme').winningLayer, 'user');
	const conflictKeys = result.conflicts.map((entry) => entry.key);
	assert.ok(conflictKeys.includes('model'));
	assert.equal(conflictKeys.includes('theme'), false);
});

test('a user settings.local.json overrides user settings.json inside the same layer', (t) => {
	const { home, projectRoot, slots } = fixture(t, {
		userSettings: json({ outputStyle: 'default' }),
		userSettingsLocal: json({ outputStyle: 'explanatory' }),
	});

	const result = mergeSettings({ home, projectRoot });
	const row = keyOf(result, 'outputStyle');

	assert.equal(row.effectiveValue, 'explanatory');
	assert.equal(row.winningLayer, 'user');
	assert.equal(row.perLayer.length, 2);

	const winner = row.perLayer.find((entry) => entry.overridden === false);
	assert.equal(winner.path, slots.userSettingsLocal);
	const loser = row.perLayer.find((entry) => entry.overridden === true);
	assert.equal(loser.path, slots.userSettings);
});

test('enterprise managed policy is absent on this machine and never invented', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ model: 'opus' }),
	});

	const result = mergeSettings({ home, projectRoot });
	const enterprise = result.layers.find((layer) => layer.id === 'enterprise');

	assert.ok(enterprise, 'enterprise must still be listed as consulted');
	assert.equal(enterprise.path, ENTERPRISE_PATH);
	assert.equal(enterprise.exists, false);
	assert.equal(enterprise.readable, false);
	assert.equal(enterprise.keyCount, 0);
	assert.ok(enterprise.error, 'an absent file reports the real error');
	assert.equal(enterprise.parseError, null);

	for (const row of result.keys) {
		assert.notEqual(row.winningLayer, 'enterprise');
		assert.equal(
			row.perLayer.some((entry) => entry.layer === 'enterprise'),
			false,
		);
	}
});

test('a local defaultMode of auto is ignored and the trusted user value stands', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ permissions: { defaultMode: 'auto' } }),
		projectSettings: json({ permissions: { defaultMode: 'auto' } }),
		localSettings: json({ permissions: { defaultMode: 'auto' } }),
	});

	const result = mergeSettings({ home, projectRoot });
	const row = keyOf(result, 'permissions.defaultMode');

	assert.equal(row.effectiveValue, 'auto');
	assert.equal(row.winningLayer, 'user');

	const local = entryOf(row, 'local');
	assert.equal(local.ignored, true);
	assert.equal(local.overridden, false, 'an ignored entry did not lose a fair fight');
	assert.match(local.ignoredReason, /auto/);
	assert.match(local.ignoredReason, /local/);

	const project = entryOf(row, 'project');
	assert.equal(project.ignored, true);
	assert.match(project.ignoredReason, /auto/);

	const user = entryOf(row, 'user');
	assert.equal(user.ignored, false);
	assert.equal(user.ignoredReason, null);
	assert.equal(user.overridden, false);
});

test('a local defaultMode other than auto wins normally over user auto', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ permissions: { defaultMode: 'auto' } }),
		localSettings: json({ permissions: { defaultMode: 'plan' } }),
	});

	const result = mergeSettings({ home, projectRoot });
	const row = keyOf(result, 'permissions.defaultMode');

	assert.equal(row.effectiveValue, 'plan');
	assert.equal(row.winningLayer, 'local');
	assert.equal(entryOf(row, 'local').ignored, false);
	assert.equal(entryOf(row, 'local').ignoredReason, null);
	assert.equal(entryOf(row, 'user').overridden, true);
	assert.equal(entryOf(row, 'user').ignored, false);
});

test('every non-auto mode from project or local still wins', (t) => {
	for (const mode of ['plan', 'acceptEdits', 'default', 'dontAsk', 'bypassPermissions']) {
		const { home, projectRoot } = fixture(t, {
			userSettings: json({ permissions: { defaultMode: 'auto' } }),
			localSettings: json({ permissions: { defaultMode: mode } }),
		});
		const row = keyOf(mergeSettings({ home, projectRoot }), 'permissions.defaultMode');
		assert.equal(row.effectiveValue, mode);
		assert.equal(row.winningLayer, 'local');
	}
});

test('an auto defaultMode nobody is allowed to set leaves the key with no live value', (t) => {
	const { home, projectRoot } = fixture(t, {
		localSettings: json({ permissions: { defaultMode: 'auto' } }),
	});

	const row = keyOf(mergeSettings({ home, projectRoot }), 'permissions.defaultMode');
	assert.equal(row.winningLayer, null);
	assert.equal(row.effectiveValue, null);
	assert.equal(entryOf(row, 'local').ignored, true);
});

test('an array-valued key stays whole and carries a line per element', (t) => {
	const allowText = [
		'{',
		'\t"permissions": {',
		'\t\t"allow": [',
		'\t\t\t"Bash(ls:*)",',
		'\t\t\t"Read(//tmp/**)"',
		'\t\t]',
		'\t}',
		'}',
		'',
	].join('\n');
	const { home, projectRoot, slots } = fixture(t, { userSettings: allowText });

	const result = mergeSettings({ home, projectRoot });
	const row = keyOf(result, 'permissions.allow');

	// The cascade replaces an array wholesale, so it is ONE key, not two.
	assert.deepEqual(row.effectiveValue, ['Bash(ls:*)', 'Read(//tmp/**)']);
	assert.equal(
		result.keys.some((entry) => entry.key.includes('permissions.allow[')),
		false,
	);

	assert.equal(row.elements.length, 2);
	assert.deepEqual(
		row.elements.map((element) => [element.index, element.value, element.line]),
		[
			[0, 'Bash(ls:*)', 4],
			[1, 'Read(//tmp/**)', 5],
		],
	);
	assert.equal(row.elements[1].link, `vscode://file${slots.userSettings}:5`);
	assert.equal(entryOf(row, 'user').line, 3);
	assert.equal(entryOf(row, 'user').elements.length, 2);
});

test('an array key OUTSIDE the union set still replaces rather than merges across layers', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ enabledMcpjsonServers: ['memory', 'context7'] }),
		localSettings: json({ enabledMcpjsonServers: ['playwright'] }),
	});

	const row = keyOf(mergeSettings({ home, projectRoot }), 'enabledMcpjsonServers');
	assert.equal(row.mergeKind, 'replace');
	assert.deepEqual(row.effectiveValue, ['playwright']);
	assert.equal(row.winningLayer, 'local');
	assert.equal(row.elements.length, 1);
	assert.equal(entryOf(row, 'user').overridden, true);
	assert.equal(entryOf(row, 'user').contributes, false);
});

test('permissions.allow unions every layer, weakest first, with exact duplicates collapsed', (t) => {
	const { home, projectRoot, slots } = fixture(t, {
		userSettings: json({ permissions: { allow: ['Bash(ls:*)', 'Bash(cat:*)'] } }),
		projectSettings: json({ permissions: { allow: ['Bash(cat:*)', 'Read(//tmp/**)'] } }),
		localSettings: json({ permissions: { allow: ['Write(//tmp/**)'] } }),
	});

	const row = keyOf(mergeSettings({ home, projectRoot }), 'permissions.allow');

	assert.equal(row.mergeKind, 'union');
	assert.deepEqual(row.effectiveValue, ['Bash(ls:*)', 'Bash(cat:*)', 'Read(//tmp/**)', 'Write(//tmp/**)']);
	// No layer wins a union key, so claiming one would be the very mistake the
	// panel exists to prevent.
	assert.equal(row.winningLayer, null);
	assert.deepEqual(row.contributingLayers, ['user', 'project', 'local']);

	for (const entry of row.perLayer) {
		assert.equal(entry.overridden, false, `${entry.layer} must not be reported as overridden`);
		assert.equal(entry.contributes, true, `${entry.layer} must be reported as contributing`);
	}

	// Union elements keep each element's own file and line, so every deep link
	// still lands on the file that actually carries that rule.
	assert.deepEqual(
		row.elements.map((element) => [element.index, element.value, element.layer, element.path]),
		[
			[0, 'Bash(ls:*)', 'user', slots.userSettings],
			[1, 'Bash(cat:*)', 'user', slots.userSettings],
			[2, 'Read(//tmp/**)', 'project', slots.projectSettings],
			[3, 'Write(//tmp/**)', 'local', slots.localSettings],
		],
	);
});

test('every documented permission list unions, not just allow', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({
			permissions: { ask: ['Bash(git push:*)'], additionalDirectories: ['/a'], deny: ['Bash(rm:*)'] },
		}),
		localSettings: json({
			permissions: { ask: ['Bash(rm:*)'], additionalDirectories: ['/b'], deny: ['Bash(curl:*)'] },
		}),
	});

	const result = mergeSettings({ home, projectRoot });
	assert.deepEqual(keyOf(result, 'permissions.ask').effectiveValue, ['Bash(git push:*)', 'Bash(rm:*)']);
	assert.deepEqual(keyOf(result, 'permissions.additionalDirectories').effectiveValue, ['/a', '/b']);
	// An enterprise-or-any-layer deny is never dropped: every deny rule is live.
	assert.deepEqual(keyOf(result, 'permissions.deny').effectiveValue, ['Bash(rm:*)', 'Bash(curl:*)']);
	for (const key of ['permissions.ask', 'permissions.additionalDirectories', 'permissions.deny']) {
		assert.equal(keyOf(result, key).mergeKind, 'union');
	}
});

test('hooks.<event> registrations from every layer all run and are reported as contributions', (t) => {
	const userHook = { matcher: 'Edit', hooks: [{ type: 'command', command: 'user-format.sh' }] };
	const projectHook = { matcher: 'Write', hooks: [{ type: 'command', command: 'project-gate.sh' }] };
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ hooks: { PostToolUse: [userHook] } }),
		projectSettings: json({ hooks: { PostToolUse: [projectHook] } }),
	});

	const row = keyOf(mergeSettings({ home, projectRoot }), 'hooks.PostToolUse');

	assert.equal(row.mergeKind, 'union');
	assert.deepEqual(row.effectiveValue, [userHook, projectHook]);
	assert.equal(row.winningLayer, null);
	assert.deepEqual(row.contributingLayers, ['user', 'project']);
	assert.deepEqual(
		row.perLayer.map((entry) => [entry.layer, entry.overridden, entry.contributes]),
		[
			['user', false, true],
			['project', false, true],
		],
	);
});

test('a scalar key is still replace-wins and names the layer that won', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ model: 'opus' }),
		projectSettings: json({ model: 'sonnet' }),
	});

	const row = keyOf(mergeSettings({ home, projectRoot }), 'model');
	assert.equal(row.mergeKind, 'replace');
	assert.equal(row.effectiveValue, 'sonnet');
	assert.equal(row.winningLayer, 'project');
	assert.deepEqual(row.contributingLayers, ['project']);
	assert.equal(entryOf(row, 'user').overridden, true);
	assert.equal(entryOf(row, 'user').contributes, false);
	assert.equal(entryOf(row, 'project').contributes, true);
});

test('a union key written as a non-array falls back to replace instead of inventing a merge', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ permissions: { allow: ['Bash(ls:*)'] } }),
		localSettings: json({ permissions: { allow: 'Bash(rm:*)' } }),
	});

	const row = keyOf(mergeSettings({ home, projectRoot }), 'permissions.allow');
	assert.equal(row.mergeKind, 'replace');
	assert.equal(row.effectiveValue, 'Bash(rm:*)');
	assert.equal(row.winningLayer, 'local');
});

test('union keys are not conflicts: contributions add up, they do not compete', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ matcher: '*' }] } }),
		projectSettings: json({
			model: 'sonnet',
			permissions: { allow: ['Read(//tmp/**)'] },
			hooks: { Stop: [{ matcher: 'Bash' }] },
		}),
	});

	const result = mergeSettings({ home, projectRoot });
	assert.deepEqual(
		result.conflicts.map((entry) => entry.key),
		['model'],
	);
	assert.equal(keyOf(result, 'permissions.allow').perLayer.length, 2);
	assert.equal(keyOf(result, 'hooks.Stop').perLayer.length, 2);
});

test('a malformed layer file surfaces parseError while the other layers still merge', (t) => {
	const { home, projectRoot, slots } = fixture(t, {
		userSettings: json({ model: 'opus', theme: 'dark' }),
		projectSettings: '{ "model": "sonnet", }\n',
		localSettings: json({ theme: 'light' }),
	});

	const result = mergeSettings({ home, projectRoot });
	const project = result.layers.find((layer) => layer.path === slots.projectSettings);

	assert.equal(project.exists, true);
	assert.equal(project.readable, true);
	assert.ok(project.parseError, 'the real parser message must be surfaced');
	assert.equal(project.keyCount, 0);

	// The broken file contributes nothing, and the rest of the cascade is intact.
	const model = keyOf(result, 'model');
	assert.equal(model.effectiveValue, 'opus');
	assert.equal(model.winningLayer, 'user');
	assert.equal(
		model.perLayer.some((entry) => entry.layer === 'project'),
		false,
	);
	assert.equal(keyOf(result, 'theme').effectiveValue, 'light');
});

test('an unknown key is flagged so a typo cannot hide', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({
			modle: 'opus',
			permissions: { defaultMode: 'plan', alow: [] },
			env: { MY_OWN_VAR: 'x' },
			hooks: { PostToolUse: [] },
			statusLine: { refreshInterval: 5 },
			autoMode: { environment: 'local' },
		}),
	});

	const result = mergeSettings({ home, projectRoot });

	assert.equal(keyOf(result, 'modle').known, false);
	assert.equal(keyOf(result, 'permissions.alow').known, false);
	assert.equal(keyOf(result, 'permissions.defaultMode').known, true);
	// Free-form subtrees: their children are named by the user or the CLI, not by
	// a closed vocabulary, so flagging them would be a false typo alarm.
	assert.equal(keyOf(result, 'env.MY_OWN_VAR').known, true);
	assert.equal(keyOf(result, 'hooks.PostToolUse').known, true);
	assert.equal(keyOf(result, 'statusLine.refreshInterval').known, true);
	assert.equal(keyOf(result, 'autoMode.environment').known, true);

	assert.ok(KNOWN_SETTING_KEYS.includes('permissions.defaultMode'));
	assert.ok(KNOWN_SETTING_KEYS.includes('skillOverrides'));
	assert.equal(KNOWN_SETTING_KEYS.includes('modle'), false);
});

test('owner-only model keys are badged wherever they appear', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({
			env: {
				ANTHROPIC_MODEL: 'claude-opus-4',
				ANTHROPIC_MODEL_FALLBACK: 'claude-haiku-4',
				EZAPPS_AGENT_MODEL: 'claude-sonnet-4',
				EZ_ALL_AGENTS_MODEL: 'claude-opus-4',
				EZ_INTENT_CLASSIFIER_MODEL: 'claude-haiku-4',
				HARMLESS_VAR: 'ok',
			},
			model: 'opus',
		}),
	});

	const result = mergeSettings({ home, projectRoot });
	for (const key of [
		'env.ANTHROPIC_MODEL',
		'env.ANTHROPIC_MODEL_FALLBACK',
		'env.EZAPPS_AGENT_MODEL',
		'env.EZ_ALL_AGENTS_MODEL',
		'env.EZ_INTENT_CLASSIFIER_MODEL',
	]) {
		assert.equal(keyOf(result, key).ownerOnly, true, `${key} must be owner-only`);
	}
	assert.equal(keyOf(result, 'env.HARMLESS_VAR').ownerOnly, false);
	assert.equal(keyOf(result, 'model').ownerOnly, false);
});

test('a secret in env never appears unmasked anywhere in the result', (t) => {
	const apiKey = 'sk-ant-api03-SUPERSECRETVALUE1234567890abcdef';
	const vendorKey = 'vk-THISISAVENDORSECRET99';
	const { home, projectRoot } = fixture(t, {
		userSettings: json({
			env: {
				ANTHROPIC_API_KEY: apiKey,
				SOMEVENDOR_API_KEY: vendorKey,
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
			},
			apiKeyHelper: `echo ${apiKey}`,
			permissions: { allow: [`Bash(curl -H "Authorization: Bearer ${apiKey}":*)`] },
		}),
	});

	const result = mergeSettings({ home, projectRoot });
	const serialized = JSON.stringify(result);

	assert.doesNotMatch(serialized, /SUPERSECRETVALUE/);
	assert.doesNotMatch(serialized, /THISISAVENDORSECRET/);
	assert.equal(serialized.includes(apiKey), false);
	assert.equal(serialized.includes(vendorKey), false);

	assert.equal(keyOf(result, 'env.ANTHROPIC_API_KEY').secret, true);
	assert.equal(keyOf(result, 'env.SOMEVENDOR_API_KEY').secret, true);
	assert.equal(keyOf(result, 'env.ANTHROPIC_API_KEY').effectiveValue.includes('…'), true);
	assert.equal(entryOf(keyOf(result, 'env.ANTHROPIC_API_KEY'), 'user').value.includes('SUPER'), false);

	// A harmless env value stays readable, or the panel is useless.
	assert.equal(keyOf(result, 'env.CLAUDE_CODE_DISABLE_AUTO_MEMORY').effectiveValue, '1');
	assert.equal(keyOf(result, 'env.CLAUDE_CODE_DISABLE_AUTO_MEMORY').secret, false);

	// Secret-shaped values outside env are redacted in place, keeping context.
	const helper = keyOf(result, 'apiKeyHelper');
	assert.equal(helper.secret, true);
	assert.match(helper.effectiveValue, /^echo /);

	const allow = keyOf(result, 'permissions.allow');
	assert.equal(allow.secret, true);
	assert.equal(allow.elements[0].value.includes('SUPERSECRET'), false);
	assert.match(allow.elements[0].value, /^Bash\(curl/);
});

test('conflicts are the subset of keys more than one source defines', (t) => {
	const { home, projectRoot } = fixture(t, {
		userSettings: json({ model: 'opus', theme: 'dark', effortLevel: 'high' }),
		projectSettings: json({ model: 'sonnet' }),
		localSettings: json({ theme: 'light' }),
	});

	const result = mergeSettings({ home, projectRoot });
	assert.deepEqual(result.conflicts.map((entry) => entry.key).sort(), ['model', 'theme']);
	for (const conflict of result.conflicts) {
		assert.ok(conflict.perLayer.length > 1);
		assert.equal(conflict.perLayer.filter((entry) => !entry.overridden && !entry.ignored).length, 1);
		assert.ok(result.keys.includes(conflict), 'conflicts must be the same objects as keys');
	}
});

test('layer rows describe every source consulted, present or not', (t) => {
	const { home, projectRoot, slots } = fixture(t, {
		userSettings: json({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }),
	});

	const result = mergeSettings({ home, projectRoot });
	assert.deepEqual(
		result.layers.map((layer) => layer.path),
		[slots.userSettings, slots.userSettingsLocal, slots.projectSettings, slots.localSettings, ENTERPRISE_PATH],
	);
	const user = result.layers[0];
	assert.equal(user.id, 'user');
	assert.equal(user.label, 'User');
	assert.equal(user.exists, true);
	assert.equal(user.keyCount, 2);

	const absent = result.layers[1];
	assert.equal(absent.exists, false);
	assert.equal(absent.keyCount, 0);
	assert.ok(absent.error);
});

test('mergeSettings refuses to guess at missing roots', () => {
	assert.throws(() => mergeSettings({ home: '/home/me' }), TypeError);
	assert.throws(() => mergeSettings({}), TypeError);
	assert.throws(() => mergeSettings(), TypeError);
});
