import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexPlugins } from '../lib/codex/plugins-scan.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-plugins-'));

function writeJson(file, obj) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function writeText(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function makeFixture(name) {
	const home = path.join(ROOT, name, 'home');
	const projectRoot = path.join(ROOT, name, 'project');
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(projectRoot, { recursive: true });
	return { home, projectRoot };
}

function pluginDir(home, marketplace, plugin, version) {
	return path.join(home, '.codex', 'plugins', 'cache', marketplace, plugin, version);
}

function writeConfigToml(home, text) {
	fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
	fs.writeFileSync(path.join(home, '.codex', 'config.toml'), text);
}

function skillFrontmatter(name, description) {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`;
}

test('lists every plugin found under cache/<marketplace>/<plugin>/<version>, keyed as name@marketplace', () => {
	const { home, projectRoot } = makeFixture('basic-listing');
	const dir = pluginDir(home, 'openai-bundled', 'sites', '0.1.37');
	writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'sites', version: '0.1.37' });
	writeConfigToml(home, `[plugins."sites@openai-bundled"]\nenabled = true\n`);

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'sites@openai-bundled');
	assert.ok(plugin, 'plugin should be listed');
	assert.equal(plugin.name, 'sites');
	assert.equal(plugin.marketplace, 'openai-bundled');
	assert.equal(plugin.version, '0.1.37');
	assert.equal(plugin.path, dir);
	assert.equal(plugin.enabled, true);
	assert.ok(plugin.enabledLine >= 1);
	assert.ok(plugin.enabledLink.startsWith('vscode://file'));
	assert.equal(plugin.manifestPath, path.join(dir, '.codex-plugin', 'plugin.json'));
	assert.deepEqual(plugin.multipleVersions, []);
});

test('a plugin absent from config.toml is disabled with enabledSource "not in config.toml"', () => {
	const { home, projectRoot } = makeFixture('absent-plugin');
	writeJson(path.join(pluginDir(home, 'mkt', 'demo', '1.0.0'), '.codex-plugin', 'plugin.json'), { name: 'demo' });
	writeConfigToml(home, '');

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.equal(plugin.enabled, false);
	assert.equal(plugin.enabledSource, 'not in config.toml');
	assert.equal(plugin.enabledLine, null);
	assert.equal(plugin.enabledLink, null);
});

test('project config.toml overrides the user config.toml for the same plugin key', () => {
	const { home, projectRoot } = makeFixture('project-override');
	writeJson(path.join(pluginDir(home, 'mkt', 'demo', '1.0.0'), '.codex-plugin', 'plugin.json'), { name: 'demo' });
	writeConfigToml(home, `[plugins."demo@mkt"]\nenabled = true\n`);
	fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, '.codex', 'config.toml'), `[plugins."demo@mkt"]\nenabled = false\n`);

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.equal(plugin.enabled, false);
	assert.equal(plugin.enabledSource, path.join(projectRoot, '.codex', 'config.toml'));
});

test('resolves skills contributed via a "./skills/" directory-path manifest field, with a real estimatedTokens', () => {
	const { home, projectRoot } = makeFixture('skills-path');
	const dir = pluginDir(home, 'mkt', 'demo', '1.0.0');
	writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'demo', skills: './skills/' });
	writeText(path.join(dir, 'skills', 'brainstorm', 'SKILL.md'), skillFrontmatter('brainstorm', 'Explore ideas.'));
	writeConfigToml(home, `[plugins."demo@mkt"]\nenabled = true\n`);

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.deepEqual(plugin.contributes.skills, ['brainstorm']);
	assert.ok(plugin.estimatedTokens > 0);
});

test('resolves mcpServers contributed via a sibling ".mcp.json" path manifest field', () => {
	const { home, projectRoot } = makeFixture('mcp-path');
	const dir = pluginDir(home, 'mkt', 'demo', '1.0.0');
	writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'demo', mcpServers: './.mcp.json' });
	writeJson(path.join(dir, '.mcp.json'), { mcpServers: { helper: { command: './bin/helper' } } });
	writeConfigToml(home, `[plugins."demo@mkt"]\nenabled = true\n`);

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.deepEqual(plugin.contributes.mcpServers, ['helper']);
});

test('resolves lspServers and hooks contributed inline in the manifest', () => {
	const { home, projectRoot } = makeFixture('inline-fields');
	const dir = pluginDir(home, 'mkt', 'demo', '1.0.0');
	writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), {
		name: 'demo',
		lspServers: { typescript: { command: 'typescript-language-server' } },
		hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }], SessionStart: [] },
	});
	writeConfigToml(home, '');

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.deepEqual(plugin.contributes.lspServers, ['typescript']);
	assert.deepEqual(plugin.contributes.hooks, ['PostToolUse']);
});

test('a plugin with no manifest.json fields present reports empty contribution arrays, never a throw', () => {
	const { home, projectRoot } = makeFixture('empty-manifest');
	const dir = pluginDir(home, 'mkt', 'bare', '1.0.0');
	writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'bare' });
	writeConfigToml(home, '');

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'bare@mkt');
	assert.deepEqual(plugin.contributes, {
		skills: [],
		commands: [],
		agents: [],
		hooks: [],
		mcpServers: [],
		apps: [],
		lspServers: [],
	});
	assert.equal(plugin.estimatedTokens, 0);
});

test('multiple cached versions: the lexicographically last is active, the rest land in multipleVersions', () => {
	const { home, projectRoot } = makeFixture('multi-version');
	writeJson(path.join(pluginDir(home, 'mkt', 'demo', '1.0.0'), '.codex-plugin', 'plugin.json'), { name: 'demo' });
	writeJson(path.join(pluginDir(home, 'mkt', 'demo', '2.0.0'), '.codex-plugin', 'plugin.json'), { name: 'demo' });
	writeConfigToml(home, '');

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.equal(plugin.version, '2.0.0');
	assert.deepEqual(plugin.multipleVersions, ['1.0.0']);
});

test('a manifest field whose relative path escapes the plugin directory is skipped, with a note', () => {
	const { home, projectRoot } = makeFixture('escaping-skills');
	const dir = pluginDir(home, 'mkt', 'demo', '1.0.0');
	writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'demo', skills: '../../outside' });

	// Real content OUTSIDE the plugin directory -- proves it is not read, not just absent.
	const outsideSkillsDir = path.join(home, '.codex', 'plugins', 'cache', 'mkt', 'outside');
	writeText(
		path.join(outsideSkillsDir, 'leaked-skill', 'SKILL.md'),
		skillFrontmatter('leaked-skill', 'Should never be listed.'),
	);
	writeConfigToml(home, `[plugins."demo@mkt"]\nenabled = true\n`);

	const result = scanCodexPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.deepEqual(plugin.contributes.skills, []);
	assert.ok(Array.isArray(plugin.manifestErrors));
	assert.ok(
		plugin.manifestErrors.includes('skills path escapes the plugin directory'),
		`expected a manifestErrors note, got ${JSON.stringify(plugin.manifestErrors)}`,
	);
});

test('marketplaces come from [marketplaces.*] in config.toml, with line/link', () => {
	const { home, projectRoot } = makeFixture('marketplaces-config');
	writeConfigToml(
		home,
		[
			'[marketplaces.claude-plugins-official]',
			'last_updated = "2026-08-21T18:28:27Z"',
			'last_revision = "340e33a"',
			'source_type = "git"',
			'source = "https://github.com/anthropics/claude-plugins-official.git"',
		].join('\n'),
	);

	const result = scanCodexPlugins({ home, projectRoot });
	const mkt = result.marketplaces.find((m) => m.name === 'claude-plugins-official');
	assert.ok(mkt);
	assert.equal(mkt.sourceType, 'git');
	assert.equal(mkt.source, 'https://github.com/anthropics/claude-plugins-official.git');
	assert.equal(mkt.lastRevision, '340e33a');
	assert.ok(mkt.line >= 1);
	assert.ok(mkt.link.startsWith('vscode://file'));
});

test('marketplaces also come from plugin-sources/* directories, merged with config entries by name', () => {
	const { home, projectRoot } = makeFixture('marketplaces-sources');
	fs.mkdirSync(path.join(home, '.codex', 'plugin-sources', 'ponytail'), { recursive: true });
	writeConfigToml(home, '');

	const result = scanCodexPlugins({ home, projectRoot });
	const mkt = result.marketplaces.find((m) => m.name === 'ponytail');
	assert.ok(mkt, 'a plugin-sources dir with no config.toml entry should still be listed');
	assert.equal(mkt.sourceType, 'local');
	assert.equal(mkt.path, path.join(home, '.codex', 'plugin-sources', 'ponytail'));
});

test('missing plugin cache and config.toml yield no plugins, no throw', () => {
	const { home, projectRoot } = makeFixture('missing-everything');
	const result = scanCodexPlugins({ home, projectRoot });
	assert.deepEqual(result.plugins, []);
	assert.deepEqual(result.marketplaces, []);
	assert.ok(Array.isArray(result.sources));
});

test('guarded reality check: the real ~/.codex plugin cache has at least 18 plugins, 15+ enabled', () => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex', 'plugins', 'cache')) || !fs.existsSync(projectRoot)) {
		return;
	}

	const result = scanCodexPlugins({ home, projectRoot });
	assert.ok(result.plugins.length >= 18, `expected >= 18 plugins, got ${result.plugins.length}`);
	const enabled = result.plugins.filter((p) => p.enabled);
	assert.ok(enabled.length >= 15, `expected >= 15 enabled plugins, got ${enabled.length}`);
	for (const plugin of result.plugins) {
		assert.ok(Array.isArray(plugin.contributes.skills));
		assert.ok(fs.existsSync(plugin.path), `${plugin.path} should exist on disk`);
	}
});

test('a version symlink pointing at a sibling version dir is an alias, never a second version', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugins-alias-'));
	const plugin = path.join(home, '.codex', 'plugins', 'cache', 'bundled', 'chrome');
	fs.mkdirSync(path.join(plugin, '26.810.50856', '.codex-plugin'), { recursive: true });
	fs.writeFileSync(
		path.join(plugin, '26.810.50856', '.codex-plugin', 'plugin.json'),
		JSON.stringify({ name: 'chrome', version: '26.810.50856' }),
	);
	fs.symlinkSync('26.810.50856', path.join(plugin, 'latest'));
	fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
	fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[plugins."chrome@bundled"]\nenabled = true\n');
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugins-alias-repo-'));
	const result = scanCodexPlugins({ home, projectRoot: repo });
	const rows = result.plugins.filter((row) => row.name === 'chrome' || row.key === 'chrome@bundled');
	assert.equal(rows.length, 1, JSON.stringify(rows.map((row) => row.version)));
	assert.equal(rows[0].version, '26.810.50856');
});
