import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CODEX_LAYERS,
	CODEX_SETTINGS_CASCADE,
	NEVER_READ,
	codexLayerById,
	codexWinningLayer,
	resolveCodexPaths,
} from '../lib/codex/layers.mjs';

test('every Codex layer has a stable id, list order and authority', () => {
	const ids = CODEX_LAYERS.map((layer) => layer.id);
	assert.deepEqual(ids, ['user', 'project', 'plugin', 'system', 'builtin']);
	assert.equal(new Set(ids).size, ids.length);
	for (const layer of CODEX_LAYERS) {
		assert.ok(Number.isInteger(layer.authority), `${layer.id} needs an authority`);
		assert.ok(layer.label.length > 0);
		assert.ok(layer.note.length > 0);
	}
});

test('project outranks user, which outranks plugin, which outranks the bundled system layer', () => {
	assert.equal(codexWinningLayer(['user', 'project']), 'project');
	assert.equal(codexWinningLayer(['user', 'plugin']), 'user');
	assert.equal(codexWinningLayer(['plugin', 'system']), 'plugin');
	assert.equal(codexWinningLayer(['user', 'project', 'plugin', 'system']), 'project');
});

test('the bundled system layer is the weakest layer that still has real files on disk', () => {
	// builtin is excluded on purpose: it has no file at all, so it never
	// competes in a shadowing contest the way an actual discovered skill does.
	const system = codexLayerById('system');
	const onDisk = CODEX_LAYERS.filter((layer) => layer.id !== 'builtin');
	for (const layer of onDisk) {
		assert.ok(layer.id === 'system' || layer.authority > system.authority, `${layer.id} should outrank system`);
	}
});

test('codexWinningLayer ignores unknown ids and empty input instead of guessing', () => {
	assert.equal(codexWinningLayer(['nonsense']), null);
	assert.equal(codexWinningLayer([]), null);
	assert.equal(codexWinningLayer(undefined), null);
	assert.equal(codexWinningLayer(['nonsense', 'user']), 'user');
});

test('the settings cascade lists the weakest layer first', () => {
	assert.deepEqual([...CODEX_SETTINGS_CASCADE], ['user', 'profile', 'project', 'cli']);
});

test('codexLayerById resolves known layers and refuses unknown ones', () => {
	assert.equal(codexLayerById('plugin').label, 'Plugin / marketplace');
	assert.equal(codexLayerById('nope'), null);
});

test('NEVER_READ lists auth.json and only auth.json, and is frozen', () => {
	assert.deepEqual([...NEVER_READ], ['auth.json']);
	assert.ok(Object.isFrozen(NEVER_READ));
});

test('resolveCodexPaths resolves the user layer under CODEX_HOME by default', () => {
	const paths = resolveCodexPaths({ home: '/home/me', projectRoot: '/repo' });
	assert.equal(paths.user.dir, '/home/me/.codex');
	assert.equal(paths.user.config, '/home/me/.codex/config.toml');
	assert.equal(paths.user.configFullAccess, '/home/me/.codex/full_access.config.toml');
	assert.equal(paths.user.memory, '/home/me/.codex/AGENTS.md');
	assert.equal(paths.user.hooksJson, '/home/me/.codex/hooks.json');
	assert.equal(paths.user.hooksDir, '/home/me/.codex/hooks');
	assert.equal(paths.user.skillsDir, '/home/me/.codex/skills');
	assert.equal(paths.user.systemSkillsDir, '/home/me/.codex/skills/.system');
	assert.equal(paths.user.promptsDir, '/home/me/.codex/prompts');
	assert.equal(paths.user.agentsDir, '/home/me/.codex/agents');
	assert.equal(paths.user.rulesDir, '/home/me/.codex/rules');
	assert.equal(paths.user.pluginsDir, '/home/me/.codex/plugins');
	assert.equal(paths.user.pluginsCacheDir, '/home/me/.codex/plugins/cache');
	assert.equal(paths.user.pluginSourcesDir, '/home/me/.codex/plugin-sources');
	assert.equal(paths.user.sessionsDir, '/home/me/.codex/sessions');
	assert.equal(paths.user.historyJsonl, '/home/me/.codex/history.jsonl');
	assert.equal(paths.user.sessionIndexJsonl, '/home/me/.codex/session_index.jsonl');
	assert.equal(paths.user.memoriesDir, '/home/me/.codex/memories');
	assert.equal(paths.user.modelsCache, '/home/me/.codex/models_cache.json');
	assert.equal(paths.user.versionJson, '/home/me/.codex/version.json');
	assert.equal(paths.user.globalState, '/home/me/.codex/.codex-global-state.json');
	assert.equal(paths.user.authJson, '/home/me/.codex/auth.json');
	assert.equal(paths.user.oauthLocksDir, '/home/me/.codex/mcp-oauth-locks');
});

test('resolveCodexPaths pins the second ~/.agents skills/plugins roots to home, not CODEX_HOME', () => {
	const paths = resolveCodexPaths({
		home: '/home/me',
		projectRoot: '/repo',
		codexHome: '/elsewhere/codex-home',
	});
	assert.equal(paths.user.agentsSkillsDir, '/home/me/.agents/skills');
	assert.equal(paths.user.agentsPluginsDir, '/home/me/.agents/plugins');
	// Everything actually rooted at CODEX_HOME follows the override, though.
	assert.equal(paths.user.dir, '/elsewhere/codex-home');
	assert.equal(paths.user.config, '/elsewhere/codex-home/config.toml');
});

test('resolveCodexPaths resolves the project layer', () => {
	const paths = resolveCodexPaths({ home: '/home/me', projectRoot: '/repo' });
	assert.equal(paths.project.root, '/repo');
	assert.equal(paths.project.memory, '/repo/AGENTS.md');
	assert.equal(paths.project.memoryOverride, '/repo/AGENTS.override.md');
	assert.equal(paths.project.codexDir, '/repo/.codex');
	assert.equal(paths.project.config, '/repo/.codex/config.toml');
	assert.equal(paths.project.hooksJson, '/repo/.codex/hooks.json');
	assert.equal(paths.project.hooksDir, '/repo/.codex/hooks');
	assert.equal(paths.project.agentsDir, '/repo/.codex/agents');
	assert.equal(paths.project.skillsDir, '/repo/.codex/skills');
	assert.equal(paths.project.agentsSkillsDir, '/repo/.agents/skills');
	assert.equal(paths.project.rulesDir, '/repo/.ai-config/shared/rules');
});

test('resolveCodexPaths resolves the plugin layer under CODEX_HOME', () => {
	const paths = resolveCodexPaths({ home: '/home/me', projectRoot: '/repo' });
	assert.equal(paths.plugin.cacheDir, '/home/me/.codex/plugins/cache');
	assert.equal(paths.plugin.sourcesDir, '/home/me/.codex/plugin-sources');
});

test('resolveCodexPaths honours an explicit codexHome option over the default', () => {
	const paths = resolveCodexPaths({ home: '/home/me', projectRoot: '/repo', codexHome: '/custom/codex' });
	assert.equal(paths.user.dir, '/custom/codex');
	assert.equal(paths.user.config, '/custom/codex/config.toml');
	assert.equal(paths.plugin.cacheDir, '/custom/codex/plugins/cache');
});

test('resolveCodexPaths honours the CODEX_HOME environment variable when no option is given', (t) => {
	const original = process.env.CODEX_HOME;
	process.env.CODEX_HOME = '/env/codex-home';
	t.after(() => {
		if (original === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = original;
	});

	const paths = resolveCodexPaths({ home: '/home/me', projectRoot: '/repo' });
	assert.equal(paths.user.dir, '/env/codex-home');
	assert.equal(paths.user.config, '/env/codex-home/config.toml');
});

test('an explicit codexHome option wins over the CODEX_HOME environment variable', (t) => {
	const original = process.env.CODEX_HOME;
	process.env.CODEX_HOME = '/env/codex-home';
	t.after(() => {
		if (original === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = original;
	});

	const paths = resolveCodexPaths({ home: '/home/me', projectRoot: '/repo', codexHome: '/explicit/codex' });
	assert.equal(paths.user.dir, '/explicit/codex');
});

test('resolveCodexPaths refuses to build paths from missing roots', () => {
	assert.throws(() => resolveCodexPaths({ projectRoot: '/repo' }), TypeError);
	assert.throws(() => resolveCodexPaths({ home: '/home/me' }), TypeError);
	assert.throws(() => resolveCodexPaths({}), TypeError);
});
