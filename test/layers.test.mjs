import assert from 'node:assert/strict';
import test from 'node:test';
import {
	AUTO_MODE_TRUSTED_LAYERS,
	LAYERS,
	SETTINGS_CASCADE,
	layerById,
	resolveLayerPaths,
	winningLayer,
	worktreeSettingsPath,
} from '../lib/layers.mjs';

test('every layer has a stable id, list order and authority', () => {
	const ids = LAYERS.map((layer) => layer.id);
	assert.deepEqual(ids, ['enterprise', 'user', 'project', 'local', 'worktree', 'plugin']);
	assert.equal(new Set(ids).size, ids.length);
	for (const layer of LAYERS) {
		assert.ok(Number.isInteger(layer.authority), `${layer.id} needs an authority`);
		assert.ok(layer.label.length > 0);
		assert.ok(layer.note.length > 0);
	}
});

test('local beats project which beats user, and enterprise beats everything', () => {
	// This is the real Claude Code cascade, not the brief's listing order.
	assert.equal(winningLayer(['user', 'project']), 'project');
	assert.equal(winningLayer(['user', 'project', 'local']), 'local');
	assert.equal(winningLayer(['user', 'project', 'local', 'enterprise']), 'enterprise');
	assert.equal(winningLayer(['user']), 'user');
});

test('winningLayer ignores unknown ids and empty input instead of guessing', () => {
	assert.equal(winningLayer(['nonsense']), null);
	assert.equal(winningLayer([]), null);
	assert.equal(winningLayer(undefined), null);
	assert.equal(winningLayer(['nonsense', 'user']), 'user');
});

test('auto mode is only trusted from enterprise and user layers', () => {
	assert.deepEqual([...AUTO_MODE_TRUSTED_LAYERS], ['enterprise', 'user']);
	assert.equal(AUTO_MODE_TRUSTED_LAYERS.includes('local'), false);
	assert.equal(AUTO_MODE_TRUSTED_LAYERS.includes('project'), false);
});

test('the settings cascade lists the weakest layer first', () => {
	assert.deepEqual([...SETTINGS_CASCADE], ['user', 'project', 'local', 'enterprise']);
});

test('layerById resolves known layers and refuses unknown ones', () => {
	assert.equal(layerById('local').label, 'Project local (per-machine)');
	assert.equal(layerById('nope'), null);
});

test('resolveLayerPaths produces absolute paths for every layer', () => {
	const paths = resolveLayerPaths({ home: '/home/me', projectRoot: '/repo' });
	assert.equal(paths.user.memory, '/home/me/.claude/CLAUDE.md');
	assert.equal(paths.user.settings, '/home/me/.claude/settings.json');
	assert.equal(paths.user.globalConfig, '/home/me/.claude.json');
	assert.equal(paths.project.memory, '/repo/.claude/CLAUDE.md');
	assert.equal(paths.project.settings, '/repo/.claude/settings.json');
	assert.equal(paths.project.mcpJson, '/repo/.mcp.json');
	assert.equal(paths.project.agentsSymlink, '/repo/AGENTS.md');
	assert.equal(paths.project.rulesDir, '/repo/.ai-config/shared/rules');
	assert.equal(paths.local.settings, '/repo/.claude/settings.local.json');
	assert.equal(paths.plugin.cacheDir, '/home/me/.claude/plugins/cache');
	assert.equal(paths.enterprise.managedSettings, '/Library/Application Support/ClaudeCode/managed-settings.json');
});

test('resolveLayerPaths refuses to build paths from missing roots', () => {
	assert.throws(() => resolveLayerPaths({ home: '/home/me' }), TypeError);
	assert.throws(() => resolveLayerPaths({}), TypeError);
});

test('worktreeSettingsPath targets the per-machine file inside a worktree', () => {
	assert.equal(worktreeSettingsPath('/repo-wt-x'), '/repo-wt-x/.claude/settings.local.json');
});
