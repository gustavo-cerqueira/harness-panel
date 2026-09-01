import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPlugins, marketplaces, pickActiveVersion } from '../lib/plugins-scan.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plugins-'));

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

function skillFrontmatter(name, description) {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`;
}

function pluginDir(home, marketplace, plugin, version) {
	return path.join(home, '.claude', 'plugins', 'cache', marketplace, plugin, version);
}

test('lists every plugin found under cache/<marketplace>/<plugin>/<version>, keyed as name@marketplace', () => {
	const { home, projectRoot } = makeFixture('basic-listing');
	const dir = pluginDir(home, 'thedotmack', 'claude-mem', '13.15.2');
	writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'claude-mem', version: '13.15.2' });
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'claude-mem@thedotmack': true } });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'claude-mem@thedotmack');
	assert.ok(plugin, 'plugin should be listed');
	assert.equal(plugin.name, 'claude-mem');
	assert.equal(plugin.marketplace, 'thedotmack');
	assert.equal(plugin.version, '13.15.2');
	assert.equal(plugin.path, dir);
});

test('enabled comes from the settings cascade: local beats project beats user', () => {
	const { home, projectRoot } = makeFixture('cascade-precedence');
	writeJson(path.join(pluginDir(home, 'mkt', 'demo', '1.0.0'), '.claude-plugin', 'plugin.json'), {
		name: 'demo',
		version: '1.0.0',
	});
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': true } });
	writeJson(path.join(projectRoot, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': false } });
	writeJson(path.join(projectRoot, '.claude', 'settings.local.json'), { enabledPlugins: { 'demo@mkt': true } });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.equal(plugin.enabled, true);
	assert.equal(plugin.enabledSource, path.join(projectRoot, '.claude', 'settings.local.json'));
	assert.ok(Number.isInteger(plugin.enabledLine) && plugin.enabledLine > 0);
	assert.ok(plugin.enabledLink.startsWith('vscode://file'));
});

test('project settings win over user settings when local is silent', () => {
	const { home, projectRoot } = makeFixture('cascade-project-over-user');
	writeJson(path.join(pluginDir(home, 'mkt', 'demo', '1.0.0'), '.claude-plugin', 'plugin.json'), {
		name: 'demo',
		version: '1.0.0',
	});
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': false } });
	writeJson(path.join(projectRoot, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': true } });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.equal(plugin.enabled, true);
	assert.equal(plugin.enabledSource, path.join(projectRoot, '.claude', 'settings.json'));
});

test('a plugin absent from every settings layer defaults to disabled with no source', () => {
	const { home, projectRoot } = makeFixture('cascade-absent');
	writeJson(path.join(pluginDir(home, 'mkt', 'demo', '1.0.0'), '.claude-plugin', 'plugin.json'), {
		name: 'demo',
		version: '1.0.0',
	});
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: {} });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.equal(plugin.enabled, false);
	assert.equal(plugin.enabledSource, null);
	assert.equal(plugin.enabledLine, null);
	assert.equal(plugin.enabledLink, null);
});

test('when multiple cached versions exist, the most recently active one wins', () => {
	const { home, projectRoot } = makeFixture('multi-version');
	const older = pluginDir(home, 'thedotmack', 'claude-mem', '13.6.2');
	const newer = pluginDir(home, 'thedotmack', 'claude-mem', '13.15.2');
	writeJson(path.join(older, '.claude-plugin', 'plugin.json'), { name: 'claude-mem', version: '13.6.2' });
	writeJson(path.join(newer, '.claude-plugin', 'plugin.json'), { name: 'claude-mem', version: '13.15.2' });
	fs.mkdirSync(path.join(older, '.in_use'), { recursive: true });
	fs.mkdirSync(path.join(newer, '.in_use'), { recursive: true });
	const past = new Date(Date.now() - 100000);
	const recent = new Date();
	fs.utimesSync(path.join(older, '.in_use'), past, past);
	fs.utimesSync(path.join(newer, '.in_use'), recent, recent);
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'claude-mem@thedotmack': true } });
	const result = scanPlugins({ home, projectRoot });
	const matches = result.plugins.filter((p) => p.key === 'claude-mem@thedotmack');
	assert.equal(matches.length, 1, 'only one active version should be reported');
	assert.equal(matches[0].version, '13.15.2');
	assert.equal(matches[0].path, newer);
});

test('contributes counts only what actually exists on disk: skills, commands, agents', () => {
	const { home, projectRoot } = makeFixture('contributes-counts');
	const dir = pluginDir(home, 'mkt', 'demo', '1.0.0');
	writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'demo', version: '1.0.0' });
	writeText(path.join(dir, 'skills', 'alpha', 'SKILL.md'), skillFrontmatter('alpha', 'Alpha skill description.'));
	writeText(path.join(dir, 'skills', 'beta', 'SKILL.md'), skillFrontmatter('beta', 'Beta skill description.'));
	writeText(path.join(dir, 'commands', 'do-thing.md'), '# do-thing\n');
	writeText(path.join(dir, 'agents', 'helper.md'), '# helper\n');
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': true } });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.deepEqual(plugin.contributes.skills.sort(), ['alpha', 'beta']);
	assert.deepEqual(plugin.contributes.commands, ['do-thing']);
	assert.deepEqual(plugin.contributes.agents, ['helper']);
});

test('hooks are counted from hooks/hooks.json as the number of registered hook actions', () => {
	const { home, projectRoot } = makeFixture('hooks-from-dir');
	const dir = pluginDir(home, 'mkt', 'demo', '1.0.0');
	writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'demo', version: '1.0.0' });
	writeJson(path.join(dir, 'hooks', 'hooks.json'), {
		hooks: {
			SessionStart: [{ hooks: [{ type: 'command', command: 'a' }] }],
			Stop: [
				{
					hooks: [
						{ type: 'command', command: 'b' },
						{ type: 'command', command: 'c' },
					],
				},
			],
		},
	});
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': true } });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.equal(plugin.contributes.hooks, 3);
});

test('hooks declared inline in the plugin manifest are counted when no hooks/ directory exists', () => {
	const { home, projectRoot } = makeFixture('hooks-from-manifest');
	const dir = pluginDir(home, 'caveman', 'caveman', 'abc123');
	writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), {
		name: 'caveman',
		hooks: {
			SessionStart: [{ hooks: [{ type: 'command', command: 'a' }] }],
			UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'b' }] }],
		},
	});
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'caveman@caveman': true } });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'caveman@caveman');
	assert.equal(plugin.contributes.hooks, 2);
});

test('contributes.mcpServers reads a wrapped .mcp.json ({ mcpServers: {...} })', () => {
	const { home, projectRoot } = makeFixture('mcp-wrapped');
	const dir = pluginDir(home, 'thedotmack', 'claude-mem', '1.0.0');
	writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'claude-mem', version: '1.0.0' });
	writeJson(path.join(dir, '.mcp.json'), { mcpServers: { 'mcp-search': { type: 'stdio', command: 'node' } } });
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'claude-mem@thedotmack': true } });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'claude-mem@thedotmack');
	assert.deepEqual(plugin.contributes.mcpServers, ['mcp-search']);
});

test('contributes.mcpServers also handles a flat, unwrapped .mcp.json', () => {
	const { home, projectRoot } = makeFixture('mcp-flat');
	const dir = pluginDir(home, 'claude-plugins-official', 'playwright', 'unknown');
	writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'playwright' });
	writeJson(path.join(dir, '.mcp.json'), { playwright: { command: 'npx', args: [] } });
	writeJson(path.join(home, '.claude', 'settings.json'), {
		enabledPlugins: { 'playwright@claude-plugins-official': true },
	});
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'playwright@claude-plugins-official');
	assert.deepEqual(plugin.contributes.mcpServers, ['playwright']);
});

test('listingChars/estimatedTokens sum (name + description + 8) per skill, only for enabled plugins', () => {
	const { home, projectRoot } = makeFixture('listing-cost');
	const enabledDir = pluginDir(home, 'mkt', 'enabled-plugin', '1.0.0');
	const disabledDir = pluginDir(home, 'mkt', 'disabled-plugin', '1.0.0');
	writeJson(path.join(enabledDir, '.claude-plugin', 'plugin.json'), { name: 'enabled-plugin', version: '1.0.0' });
	writeJson(path.join(disabledDir, '.claude-plugin', 'plugin.json'), { name: 'disabled-plugin', version: '1.0.0' });
	writeText(path.join(enabledDir, 'skills', 'alpha', 'SKILL.md'), skillFrontmatter('alpha', 'A short description.'));
	writeText(path.join(disabledDir, 'skills', 'beta', 'SKILL.md'), skillFrontmatter('beta', 'Another description.'));
	writeJson(path.join(home, '.claude', 'settings.json'), {
		enabledPlugins: { 'enabled-plugin@mkt': true, 'disabled-plugin@mkt': false },
	});
	const result = scanPlugins({ home, projectRoot });
	const enabled = result.plugins.find((p) => p.key === 'enabled-plugin@mkt');
	const disabled = result.plugins.find((p) => p.key === 'disabled-plugin@mkt');
	const expected = 'alpha'.length + 'A short description.'.length + 8;
	assert.equal(enabled.listingChars, expected);
	assert.ok(enabled.estimatedTokens > 0);
	assert.equal(disabled.listingChars, 0);
	assert.equal(disabled.estimatedTokens, 0);
});

test('a plugin manifest that fails to parse surfaces the real error without fabricating contributes', () => {
	const { home, projectRoot } = makeFixture('broken-manifest');
	const dir = pluginDir(home, 'mkt', 'broken', '1.0.0');
	fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{ not valid json');
	writeText(path.join(dir, 'skills', 'alpha', 'SKILL.md'), skillFrontmatter('alpha', 'desc'));
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'broken@mkt': true } });
	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'broken@mkt');
	assert.ok(plugin, 'plugin should still be listed by directory name');
	assert.ok(plugin.error, 'parse error should be surfaced');
	assert.deepEqual(plugin.contributes.skills, ['alpha']);
});

test('marketplaces() reads extraKnownMarketplaces from user settings', () => {
	const { home } = makeFixture('marketplaces-user');
	writeJson(path.join(home, '.claude', 'settings.json'), {
		extraKnownMarketplaces: {
			thedotmack: { source: { source: 'github', repo: 'thedotmack/claude-mem' } },
		},
	});
	const list = marketplaces({ home });
	const entry = list.find((m) => m.name === 'thedotmack');
	assert.ok(entry);
	assert.deepEqual(entry.source, { source: 'github', repo: 'thedotmack/claude-mem' });
});

test('marketplaces() also picks up marketplaces materialized under repos/ but not declared as extra', () => {
	const { home } = makeFixture('marketplaces-repos');
	writeJson(path.join(home, '.claude', 'settings.json'), { extraKnownMarketplaces: {} });
	const repoPath = path.join(home, '.claude', 'plugins', 'repos', 'some-local-marketplace');
	fs.mkdirSync(repoPath, { recursive: true });
	const list = marketplaces({ home });
	const entry = list.find((m) => m.name === 'some-local-marketplace');
	assert.ok(entry, 'repos/ directory marketplace should be listed');
	assert.equal(entry.path, repoPath);
});

test('scanPlugins tolerates a completely empty home (no plugins directory at all)', () => {
	const { home, projectRoot } = makeFixture('empty-home');
	const result = scanPlugins({ home, projectRoot });
	assert.deepEqual(result.plugins, []);
});

test('a plugin version directory reached only through a symlink is still discovered', () => {
	const { home, projectRoot } = makeFixture('symlinked-version');
	const realVersionDir = path.join(ROOT, 'symlinked-version', 'elsewhere', '1.0.0');
	writeJson(path.join(realVersionDir, '.claude-plugin', 'plugin.json'), { name: 'demo', version: '1.0.0' });
	const pluginParentDir = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'demo');
	fs.mkdirSync(pluginParentDir, { recursive: true });
	fs.symlinkSync(realVersionDir, path.join(pluginParentDir, '1.0.0'), 'dir');
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': true } });

	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.ok(plugin, 'the plugin should be discovered through the symlinked version directory');
	assert.equal(plugin.version, '1.0.0');
});

test('a plugin skill reached only through a symlinked directory is counted in contributes.skills and listingChars', () => {
	const { home, projectRoot } = makeFixture('symlinked-skill');
	const dir = pluginDir(home, 'mkt', 'demo', '1.0.0');
	writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'demo', version: '1.0.0' });
	writeText(path.join(dir, 'skills', 'alpha', 'SKILL.md'), skillFrontmatter('alpha', 'Alpha skill description.'));
	const realBetaDir = path.join(ROOT, 'symlinked-skill', 'elsewhere', 'beta');
	writeText(path.join(realBetaDir, 'SKILL.md'), skillFrontmatter('beta', 'Beta skill description.'));
	fs.symlinkSync(realBetaDir, path.join(dir, 'skills', 'beta'), 'dir');
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': true } });

	const result = scanPlugins({ home, projectRoot });
	const plugin = result.plugins.find((p) => p.key === 'demo@mkt');
	assert.deepEqual(plugin.contributes.skills.sort(), ['alpha', 'beta']);
	const expectedChars =
		'alpha'.length + 'Alpha skill description.'.length + 8 + ('beta'.length + 'Beta skill description.'.length + 8);
	assert.equal(plugin.listingChars, expectedChars);
});

test('a broken symlink under the plugins cache is skipped without crashing scanPlugins', () => {
	const { home, projectRoot } = makeFixture('broken-cache-symlink');
	const marketplaceDir = path.join(home, '.claude', 'plugins', 'cache', 'mkt');
	fs.mkdirSync(marketplaceDir, { recursive: true });
	fs.symlinkSync(path.join(home, 'does-not-exist'), path.join(marketplaceDir, 'ghost-plugin'), 'dir');
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: {} });

	const result = scanPlugins({ home, projectRoot });
	assert.equal(
		result.plugins.find((p) => p.name === 'ghost-plugin'),
		undefined,
	);
});

test('scanPlugins carries the marketplace list, so the section can render its sources', () => {
	const { home, projectRoot } = makeFixture('scan-carries-marketplaces');
	writeJson(path.join(pluginDir(home, 'mkt', 'demo', '1.0.0'), '.claude-plugin', 'plugin.json'), { name: 'demo' });
	writeJson(path.join(home, '.claude', 'settings.json'), {
		enabledPlugins: { 'demo@mkt': true },
		extraKnownMarketplaces: { mkt: { source: 'https://example.test/mkt.git' } },
	});

	const result = scanPlugins({ home, projectRoot });
	const mkt = result.marketplaces.find((m) => m.name === 'mkt');
	assert.ok(mkt, 'the marketplace a plugin came from must be reachable from the section payload');
	assert.equal(mkt.source, 'https://example.test/mkt.git');
});

test('pickActiveVersion is exported so sibling scanners resolve the live version the same way', () => {
	const { home } = makeFixture('shared-active-version');
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'demo');
	for (const version of ['1.0.0', '2.0.0']) fs.mkdirSync(path.join(parent, version), { recursive: true });
	fs.mkdirSync(path.join(parent, '1.0.0', '.in_use'), { recursive: true });
	fs.mkdirSync(path.join(parent, '2.0.0', '.in_use'), { recursive: true });
	const past = new Date(Date.now() - 60 * 60 * 1000);
	const recent = new Date();
	fs.utimesSync(path.join(parent, '1.0.0', '.in_use'), past, past);
	fs.utimesSync(path.join(parent, '2.0.0', '.in_use'), recent, recent);

	assert.equal(pickActiveVersion(['1.0.0', '2.0.0'], parent), '2.0.0');
	// No marker anywhere: the deterministic fallback, never a guess at semver.
	const bare = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'bare');
	for (const version of ['0.1.0', '0.2.0']) fs.mkdirSync(path.join(bare, version), { recursive: true });
	assert.equal(pickActiveVersion(['0.1.0', '0.2.0'], bare), '0.2.0');
	assert.equal(pickActiveVersion([], bare), null);
});

test('installed_plugins.json decides the active version when it disagrees with the .in_use marker', () => {
	const { home, projectRoot } = makeFixture('installed-plugins-record');
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'demo');
	for (const version of ['1.0.8', '1.0.9']) {
		writeJson(path.join(parent, version, '.claude-plugin', 'plugin.json'), { name: 'demo', version });
	}
	// A stale `.in_use` left behind by an old session points at 1.0.8 ...
	fs.mkdirSync(path.join(parent, '1.0.8', '.in_use'), { recursive: true });
	// ... but the installer's own record says 1.0.9 is what is installed.
	writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
		version: 2,
		plugins: {
			'demo@mkt': [{ scope: 'user', installPath: path.join(parent, '1.0.9'), version: '1.0.9' }],
		},
	});
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'demo@mkt': true } });

	assert.equal(pickActiveVersion(['1.0.8', '1.0.9'], parent), '1.0.9');
	const plugin = scanPlugins({ home, projectRoot }).plugins.find((p) => p.key === 'demo@mkt');
	assert.equal(plugin.version, '1.0.9');
});

test('a version named in installed_plugins.json but no longer cached falls back to the marker', () => {
	const { home } = makeFixture('installed-plugins-pruned');
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'demo');
	for (const version of ['1.0.8', '1.0.9']) fs.mkdirSync(path.join(parent, version), { recursive: true });
	fs.mkdirSync(path.join(parent, '1.0.8', '.in_use'), { recursive: true });
	writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
		version: 2,
		plugins: { 'demo@mkt': [{ installPath: path.join(parent, '9.9.9'), version: '9.9.9' }] },
	});

	assert.equal(pickActiveVersion(['1.0.8', '1.0.9'], parent), '1.0.8');
});

test('a marketplace an installed plugin names is listed even when nothing declares it', () => {
	const { home, projectRoot } = makeFixture('marketplace-from-installed');
	// The catalogue Claude Code ships with is in neither extraKnownMarketplaces
	// nor repos/, so a list built from those two alone omits the marketplace the
	// installed plugins actually came from.
	writeJson(
		path.join(pluginDir(home, 'claude-plugins-official', 'frontend-design', '1.0.0'), '.claude-plugin', 'plugin.json'),
		{
			name: 'frontend-design',
			version: '1.0.0',
		},
	);
	writeJson(path.join(home, '.claude', 'settings.json'), {
		enabledPlugins: { 'frontend-design@claude-plugins-official': true },
	});

	const official = scanPlugins({ home, projectRoot }).marketplaces.find((m) => m.name === 'claude-plugins-official');
	assert.ok(official, 'a marketplace an installed plugin came from must appear in the list');
	assert.equal(official.source, null, 'we know it serves them and not where it is fetched from');
	assert.equal(official.foundVia, 'installed-plugin');
	assert.equal(official.servesPlugins, 1);
});

test('a declared marketplace is counted by the plugins that use it, never duplicated', () => {
	const { home, projectRoot } = makeFixture('marketplace-counting');
	for (const name of ['alpha', 'beta']) {
		writeJson(path.join(pluginDir(home, 'acme', name, '1.0.0'), '.claude-plugin', 'plugin.json'), {
			name,
			version: '1.0.0',
		});
	}
	writeJson(path.join(home, '.claude', 'settings.json'), {
		extraKnownMarketplaces: { acme: { source: { source: 'github', repo: 'acme/catalogue' } } },
		enabledPlugins: { 'alpha@acme': true, 'beta@acme': true },
	});

	const acme = scanPlugins({ home, projectRoot }).marketplaces.filter((m) => m.name === 'acme');
	assert.equal(acme.length, 1, 'two plugins from one marketplace are still one marketplace');
	assert.deepEqual(acme[0].source, { source: 'github', repo: 'acme/catalogue' });
	assert.equal(acme[0].servesPlugins, 2);
	assert.equal(acme[0].foundVia, undefined, 'a declared marketplace was not discovered via a plugin');
});

test('a cache with plugin version directories but no manifest anywhere raises a loud format-drift note', () => {
	const { home, projectRoot } = makeFixture('drift-no-manifests');
	// Version dir exists (the layout's deepest documented level), but no
	// .claude-plugin/plugin.json was ever written inside it.
	fs.mkdirSync(pluginDir(home, 'mkt', 'demo', '1.0.0'), { recursive: true });
	const result = scanPlugins({ home, projectRoot });
	assert.ok(
		result.notes.some((note) => /format may have changed|layout may have changed/i.test(note)),
		`expected a drift note, got: ${JSON.stringify(result.notes)}`,
	);
	assert.ok(result.notes.some((note) => note.includes('mkt/demo/1.0.0')));
});

test('a cache with at least one real manifest raises no drift note even if others are missing', () => {
	const { home, projectRoot } = makeFixture('drift-partial');
	writeJson(path.join(pluginDir(home, 'mkt', 'good', '1.0.0'), '.claude-plugin', 'plugin.json'), { name: 'good' });
	fs.mkdirSync(pluginDir(home, 'mkt', 'broken', '1.0.0'), { recursive: true });
	const result = scanPlugins({ home, projectRoot });
	assert.deepEqual(result.notes, []);
});

test('an empty plugin cache (no version directories at all) raises no drift note', () => {
	const { home, projectRoot } = makeFixture('drift-empty-cache');
	fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cache'), { recursive: true });
	const result = scanPlugins({ home, projectRoot });
	assert.deepEqual(result.notes, []);
});

test('a missing plugin cache directory raises no drift note', () => {
	const { home, projectRoot } = makeFixture('drift-missing-cache');
	const result = scanPlugins({ home, projectRoot });
	assert.deepEqual(result.notes, []);
});
