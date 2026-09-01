import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanMcpServers } from '../lib/mcp-scan.mjs';

// Every fixture lives under its own temp dir so scenarios never bleed into
// each other. The library under test never writes; only this scaffolding does.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-'));

function writeJson(file, obj) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function makeFixture(name) {
	const home = path.join(ROOT, name, 'home');
	const projectRoot = path.join(ROOT, name, 'project');
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(projectRoot, { recursive: true });
	return { home, projectRoot };
}

test('reads user-scope stdio servers with a source link into ~/.claude.json', () => {
	const { home, projectRoot } = makeFixture('user-stdio');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: {
			obsidian: { type: 'stdio', command: '/usr/local/bin/mcp-obsidian', args: ['--vault', '/vault'] },
		},
		projects: {},
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'obsidian');
	assert.ok(server, 'obsidian should be found');
	assert.equal(server.scope, 'user');
	assert.equal(server.transport, 'stdio');
	assert.equal(server.command, '/usr/local/bin/mcp-obsidian');
	assert.deepEqual(server.args, ['--vault', '/vault']);
	assert.equal(server.sourcePath, path.join(home, '.claude.json'));
	assert.ok(Number.isInteger(server.line) && server.line > 0);
	assert.equal(server.link, `vscode://file${server.sourcePath}:${server.line}`);
});

test('name normalization turns dots and spaces into underscores', () => {
	const { home, projectRoot } = makeFixture('normalize');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: {
			'my server.v2': { type: 'stdio', command: 'run' },
		},
		projects: {},
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'my server.v2');
	assert.equal(server.normalizedName, 'my_server_v2');
});

test('http transport is detected from a url and a declared type', () => {
	const { home, projectRoot } = makeFixture('http-transport');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: {
			remote: { type: 'sse', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' } },
		},
		projects: {},
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'remote');
	assert.equal(server.transport, 'sse');
	assert.equal(server.url, 'https://example.com/mcp');
	assert.equal(server.command, null);
});

test('http transport defaults when no type is declared but a url is present', () => {
	const { home, projectRoot } = makeFixture('http-default');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: { remote: { url: 'https://example.com/mcp' } },
		projects: {},
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'remote');
	assert.equal(server.transport, 'http');
});

test('reads local-scope servers from projects[projectRoot].mcpServers, distinct from user scope', () => {
	const { home, projectRoot } = makeFixture('local-scope');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: { shared: { type: 'stdio', command: 'user-cmd' } },
		projects: {
			[projectRoot]: {
				mcpServers: { 'project-local': { type: 'stdio', command: 'local-cmd' } },
			},
		},
	});
	const result = scanMcpServers({ home, projectRoot });
	const userServer = result.servers.find((s) => s.name === 'shared' && s.scope === 'user');
	const localServer = result.servers.find((s) => s.name === 'project-local' && s.scope === 'local');
	assert.ok(userServer);
	assert.ok(localServer);
	assert.equal(localServer.command, 'local-cmd');
	assert.equal(localServer.sourcePath, path.join(home, '.claude.json'));
});

test('project scope reads .mcp.json when present', () => {
	const { home, projectRoot } = makeFixture('project-scope-present');
	writeJson(path.join(home, '.claude.json'), { mcpServers: {}, projects: {} });
	writeJson(path.join(projectRoot, '.mcp.json'), {
		mcpServers: { 'repo-server': { type: 'stdio', command: 'repo-cmd' } },
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'repo-server');
	assert.ok(server);
	assert.equal(server.scope, 'project');
	assert.equal(server.sourcePath, path.join(projectRoot, '.mcp.json'));
	assert.equal(result.sources.project.exists, true);
});

test('an absent .mcp.json renders project scope as exists:false, never invented', () => {
	const { home, projectRoot } = makeFixture('project-scope-absent');
	writeJson(path.join(home, '.claude.json'), { mcpServers: {}, projects: {} });
	// deliberately no .mcp.json written
	const result = scanMcpServers({ home, projectRoot });
	assert.equal(result.sources.project.exists, false);
	assert.equal(result.sources.project.path, path.join(projectRoot, '.mcp.json'));
	assert.ok(result.sources.project.error);
	assert.equal(
		result.servers.some((s) => s.scope === 'project'),
		false,
	);
});

test('a disabled server records which file and line disabled it', () => {
	const { home, projectRoot } = makeFixture('disabled-server');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: { obsidian: { type: 'stdio', command: 'mcp-obsidian' }, other: { type: 'stdio', command: 'x' } },
		projects: {
			[projectRoot]: { disabledMcpServers: ['obsidian'] },
		},
	});
	const result = scanMcpServers({ home, projectRoot });
	const disabled = result.servers.find((s) => s.name === 'obsidian');
	const enabled = result.servers.find((s) => s.name === 'other');
	assert.equal(disabled.disabled, true);
	assert.ok(disabled.disabledSource, 'disabledSource should be populated');
	assert.equal(disabled.disabledSource.path, path.join(home, '.claude.json'));
	assert.ok(Number.isInteger(disabled.disabledSource.line) && disabled.disabledSource.line > 0);
	assert.ok(disabled.disabledSource.link.startsWith('vscode://file'));
	assert.equal(enabled.disabled, false);
	assert.equal(enabled.disabledSource, null);
});

test('project-scope disabled state comes from disabledMcpjsonServers in the settings cascade', () => {
	const { home, projectRoot } = makeFixture('mcpjson-disabled');
	writeJson(path.join(home, '.claude.json'), { mcpServers: {}, projects: {} });
	writeJson(path.join(projectRoot, '.mcp.json'), {
		mcpServers: { 'repo-server': { type: 'stdio', command: 'repo-cmd' } },
	});
	writeJson(path.join(home, '.claude', 'settings.json'), {
		disabledMcpjsonServers: ['repo-server'],
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'repo-server');
	assert.equal(server.disabled, true);
	assert.ok(server.disabledSource);
	assert.equal(server.disabledSource.path, path.join(home, '.claude', 'settings.json'));
});

test('needsAuth is null, never false, when the auth cache file is absent', () => {
	const { home, projectRoot } = makeFixture('no-auth-cache');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: { obsidian: { type: 'stdio', command: 'mcp-obsidian' } },
		projects: {},
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'obsidian');
	assert.equal(server.needsAuth, null);
	assert.equal(server.authCacheMtime, null);
});

test('needsAuth reflects a present cache entry and carries the cache file mtime for staleness', () => {
	const { home, projectRoot } = makeFixture('auth-cache-hit');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: { obsidian: { type: 'stdio', command: 'mcp-obsidian' } },
		projects: {},
	});
	const cacheFile = path.join(home, '.claude', 'mcp-needs-auth-cache.json');
	writeJson(cacheFile, { obsidian: { timestamp: Date.now() } });
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'obsidian');
	assert.equal(server.needsAuth, true);
	const realMtime = fs.statSync(cacheFile).mtimeMs;
	assert.equal(server.authCacheMtime, realMtime);
});

test('needsAuth stays null for a server absent from a present cache file (unknown, not false)', () => {
	const { home, projectRoot } = makeFixture('auth-cache-miss');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: { obsidian: { type: 'stdio', command: 'mcp-obsidian' } },
		projects: {},
	});
	writeJson(path.join(home, '.claude', 'mcp-needs-auth-cache.json'), {
		'plugin:small-business:quickbooks': { timestamp: Date.now() },
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'obsidian');
	assert.equal(server.needsAuth, null);
});

test('env and headers are masked; envKeys exposes only key names', () => {
	const { home, projectRoot } = makeFixture('masked-env');
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: {
			secretive: {
				type: 'stdio',
				command: 'run',
				env: { ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop1234', PORT: '4000' },
			},
			http: {
				type: 'http',
				url: 'https://example.com',
				headers: { Authorization: 'Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
			},
		},
		projects: {},
	});
	const result = scanMcpServers({ home, projectRoot });
	const stdioServer = result.servers.find((s) => s.name === 'secretive');
	const httpServer = result.servers.find((s) => s.name === 'http');
	assert.deepEqual(stdioServer.envKeys.sort(), ['ANTHROPIC_API_KEY', 'PORT']);
	assert.match(stdioServer.env.ANTHROPIC_API_KEY, /^sk-…1234$/);
	assert.equal(stdioServer.env.PORT, '4000');
	// maskEnv masks the whole header VALUE (not a substring within it), so a
	// "Bearer <token>" header is masked start-to-end; the only thing that
	// matters is that the raw token never survives in the output.
	assert.match(httpServer.headers.Authorization, /^Bea…aaaa$/);
	assert.equal(httpServer.headers.Authorization.includes('ghp_'), false);
});

test('JSON.stringify(result) never contains an unmasked secret', () => {
	const { home, projectRoot } = makeFixture('no-leak');
	const secret = 'sk-ant-oat01-supersecretvalue9876543210';
	writeJson(path.join(home, '.claude.json'), {
		mcpServers: {
			secretive: { type: 'stdio', command: 'run', env: { ANTHROPIC_API_KEY: secret } },
		},
		projects: {},
	});
	const result = scanMcpServers({ home, projectRoot });
	const serialized = JSON.stringify(result);
	assert.equal(serialized.includes('supersecret'), false);
	assert.equal(serialized.includes(secret), false);
});

test('plugin-scope servers are namespaced as plugin_<plugin>_<server>, wrapped .mcp.json shape', () => {
	const { home, projectRoot } = makeFixture('plugin-wrapped');
	writeJson(path.join(home, '.claude.json'), { mcpServers: {}, projects: {} });
	const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', '1.0.0');
	fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
	writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), { name: 'claude-mem', version: '1.0.0' });
	writeJson(path.join(pluginDir, '.mcp.json'), {
		mcpServers: { 'mcp-search': { type: 'stdio', command: 'node', args: ['server.js'] } },
	});
	writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'claude-mem@thedotmack': true } });
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.scope === 'plugin' && s.name === 'mcp-search');
	assert.ok(server, 'plugin mcp server should be found');
	assert.equal(server.normalizedName, 'plugin_claude-mem_mcp-search');
	assert.equal(server.disabled, false);
});

test('plugin-scope servers also handle a flat, unwrapped .mcp.json shape', () => {
	const { home, projectRoot } = makeFixture('plugin-flat');
	writeJson(path.join(home, '.claude.json'), { mcpServers: {}, projects: {} });
	const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'playwright', 'unknown');
	fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
	writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), { name: 'playwright' });
	writeJson(path.join(pluginDir, '.mcp.json'), { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } });
	writeJson(path.join(home, '.claude', 'settings.json'), {
		enabledPlugins: { 'playwright@claude-plugins-official': true },
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.scope === 'plugin' && s.name === 'playwright');
	assert.ok(server);
	assert.equal(server.normalizedName, 'plugin_playwright_playwright');
	assert.equal(server.command, 'npx');
});

test('a plugin-scope server is disabled when its owning plugin is disabled, sourced from the cascade', () => {
	const { home, projectRoot } = makeFixture('plugin-disabled');
	writeJson(path.join(home, '.claude.json'), { mcpServers: {}, projects: {} });
	const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'playwright', 'unknown');
	fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
	writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), { name: 'playwright' });
	writeJson(path.join(pluginDir, '.mcp.json'), { playwright: { command: 'npx', args: [] } });
	writeJson(path.join(home, '.claude', 'settings.json'), {
		enabledPlugins: { 'playwright@claude-plugins-official': false },
	});
	const result = scanMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.scope === 'plugin' && s.name === 'playwright');
	assert.equal(server.disabled, true);
	assert.ok(server.disabledSource);
	assert.equal(server.disabledSource.path, path.join(home, '.claude', 'settings.json'));
});

test('a missing ~/.claude.json is reported honestly, never invented', () => {
	const { home, projectRoot } = makeFixture('missing-global-config');
	const result = scanMcpServers({ home, projectRoot });
	assert.equal(result.sources.user.exists, false);
	assert.ok(result.sources.user.error);
	assert.equal(result.servers.length, 0);
});

test('a malformed ~/.claude.json surfaces the real parse error without throwing', () => {
	const { home, projectRoot } = makeFixture('malformed-global-config');
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(home, '.claude.json'), '{ "mcpServers": ');
	assert.doesNotThrow(() => scanMcpServers({ home, projectRoot }));
	const result = scanMcpServers({ home, projectRoot });
	assert.equal(result.sources.user.exists, true);
	assert.ok(result.sources.user.error || result.sources.user.parseError);
	assert.equal(result.servers.length, 0);
});
