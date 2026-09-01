import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexMcpServers } from '../lib/codex/mcp-scan.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-mcp-'));

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

function writeConfigToml(home, text) {
	fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
	fs.writeFileSync(path.join(home, '.codex', 'config.toml'), text);
}

function writeProjectConfigToml(projectRoot, text) {
	fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, '.codex', 'config.toml'), text);
}

test('reads a user-scope stdio server with command + args joined, and an env var declared by name only', () => {
	const { home, projectRoot } = makeFixture('user-stdio');
	writeConfigToml(
		home,
		[
			'[mcp_servers.basic-memory]',
			'command = "/Users/x/.local/bin/basic-memory"',
			'args = ["mcp"]',
			'',
			'[mcp_servers.basic-memory.env]',
			'API_KEY = "super-secret-value-should-never-appear"',
		].join('\n'),
	);

	const result = scanCodexMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'basic-memory');
	assert.ok(server);
	assert.equal(server.scope, 'user');
	assert.equal(server.transport, 'stdio');
	assert.equal(server.command, '/Users/x/.local/bin/basic-memory mcp');
	assert.equal(server.normalizedName, 'mcp__basic_memory');
	assert.deepEqual(server.envKeys, ['API_KEY']);
	assert.equal(server.sourcePath, path.join(home, '.codex', 'config.toml'));
	assert.ok(server.line >= 1);
	assert.equal(server.link, `vscode://file${server.sourcePath}:${server.line}`);
	// the raw secret value must never appear anywhere in the returned row
	const serialized = JSON.stringify(server);
	assert.ok(
		!serialized.includes('super-secret-value-should-never-appear'),
		'env values must never be emitted, masked or not',
	);
});

test('name normalization: dashes become underscores under the mcp__ prefix', () => {
	const { home, projectRoot } = makeFixture('normalize');
	writeConfigToml(home, ['[mcp_servers.claude-peers]', 'command = "bun"'].join('\n'));
	const result = scanCodexMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'claude-peers');
	assert.equal(server.normalizedName, 'mcp__claude_peers');
});

test('http transport is detected from a url, with env_http_headers keys folded into envKeys', () => {
	const { home, projectRoot } = makeFixture('http-transport');
	writeConfigToml(
		home,
		[
			'[mcp_servers.context7]',
			'url = "https://mcp.context7.com/mcp"',
			'',
			'[mcp_servers.context7.env_http_headers]',
			'X-Context7-API-Key = "CONTEXT7_API_KEY"',
		].join('\n'),
	);
	const result = scanCodexMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'context7');
	assert.equal(server.transport, 'http');
	assert.equal(server.url, 'https://mcp.context7.com/mcp');
	assert.equal(server.command, null);
	assert.deepEqual(server.envKeys, ['X-Context7-API-Key']);
});

test('enabled = false marks a server disabled with a path:line disabledSource', () => {
	const { home, projectRoot } = makeFixture('disabled');
	writeConfigToml(home, ['[mcp_servers.playwright]', 'command = "npx"', 'enabled = false'].join('\n'));
	const result = scanCodexMcpServers({ home, projectRoot });
	const server = result.servers.find((s) => s.name === 'playwright');
	assert.equal(server.disabled, true);
	assert.match(server.disabledSource, /config\.toml:\d+$/);
});

test('timeouts, tool lists, approval modes and required are read verbatim, absent -> null/empty, never fabricated defaults', () => {
	const { home, projectRoot } = makeFixture('extras');
	writeConfigToml(
		home,
		[
			'[mcp_servers.full]',
			'command = "run"',
			'startup_timeout_sec = 120.0',
			'tool_timeout_sec = 30',
			'enabled_tools = ["a", "b"]',
			'disabled_tools = ["c"]',
			'default_tools_approval_mode = "prompt"',
			'required = true',
			'',
			'[mcp_servers.full.tools.risky]',
			'approval_mode = "approve"',
			'',
			'[mcp_servers.minimal]',
			'command = "run2"',
		].join('\n'),
	);
	const result = scanCodexMcpServers({ home, projectRoot });
	const full = result.servers.find((s) => s.name === 'full');
	assert.equal(full.startupTimeoutSec, 120);
	assert.equal(full.toolTimeoutSec, 30);
	assert.deepEqual(full.enabledTools, ['a', 'b']);
	assert.deepEqual(full.disabledTools, ['c']);
	assert.equal(full.defaultToolsApprovalMode, 'prompt');
	assert.equal(full.required, true);
	assert.deepEqual(full.toolApprovalModes, { risky: 'approve' });

	const minimal = result.servers.find((s) => s.name === 'minimal');
	assert.equal(minimal.startupTimeoutSec, null);
	assert.equal(minimal.toolTimeoutSec, null);
	assert.deepEqual(minimal.enabledTools, []);
	assert.deepEqual(minimal.disabledTools, []);
	assert.equal(minimal.defaultToolsApprovalMode, null);
	assert.equal(minimal.required, null);
	assert.deepEqual(minimal.toolApprovalModes, {});
});

test('a project .codex/config.toml server is scope project, separate from the user scope', () => {
	const { home, projectRoot } = makeFixture('project-scope');
	writeConfigToml(home, ['[mcp_servers.shared]', 'command = "user-cmd"'].join('\n'));
	writeProjectConfigToml(projectRoot, ['[mcp_servers.project-only]', 'command = "local-cmd"'].join('\n'));

	const result = scanCodexMcpServers({ home, projectRoot });
	const userServer = result.servers.find((s) => s.name === 'shared' && s.scope === 'user');
	const projectServer = result.servers.find((s) => s.name === 'project-only' && s.scope === 'project');
	assert.ok(userServer);
	assert.ok(projectServer);
	assert.equal(projectServer.sourcePath, path.join(projectRoot, '.codex', 'config.toml'));
});

test('a profile file (*.config.toml) contributes ignored: true rows, never merged silently into the active set', () => {
	const { home, projectRoot } = makeFixture('profile');
	writeConfigToml(home, ['[mcp_servers.playwright]', 'command = "npx"'].join('\n'));
	fs.writeFileSync(
		path.join(home, '.codex', 'full_access.config.toml'),
		['[mcp_servers.playwright.tools.browser_navigate]', 'approval_mode = "auto"'].join('\n'),
	);

	const result = scanCodexMcpServers({ home, projectRoot });
	const profileRow = result.servers.find((s) => s.scope === 'profile' && s.name === 'playwright');
	assert.ok(profileRow, 'the profile overlay row should be reported');
	assert.equal(profileRow.ignored, true);
	assert.equal(profileRow.command, null);
	assert.deepEqual(profileRow.toolApprovalModes, { browser_navigate: 'auto' });

	const activeRow = result.servers.find((s) => s.scope === 'user' && s.name === 'playwright');
	assert.equal(activeRow.ignored, false);

	const sourcePaths = result.sources.map((s) => s.path);
	assert.ok(sourcePaths.includes(path.join(home, '.codex', 'full_access.config.toml')));
});

test('a plugin-contributed server: display name is <plugin>:<server>, normalizedName is the bare server id', () => {
	const { home, projectRoot } = makeFixture('plugin-server');
	const pluginDir = path.join(home, '.codex', 'plugins', 'cache', 'openai-bundled', 'computer-use', '1.0.0');
	writeJson(path.join(pluginDir, '.codex-plugin', 'plugin.json'), { name: 'computer-use', mcpServers: './.mcp.json' });
	writeJson(path.join(pluginDir, '.mcp.json'), {
		mcpServers: { 'computer-use': { command: './bin/computer-use-client-launcher', args: ['mcp'] } },
	});
	writeConfigToml(home, ['[plugins."computer-use@openai-bundled"]', 'enabled = true'].join('\n'));

	const result = scanCodexMcpServers({ home, projectRoot });
	const row = result.servers.find((s) => s.scope === 'plugin');
	assert.ok(row);
	assert.equal(row.name, 'computer-use:computer-use');
	assert.equal(row.normalizedName, 'mcp__computer_use');
	assert.equal(row.disabled, false);
	assert.equal(row.command, './bin/computer-use-client-launcher mcp');
});

test('a disabled plugin disables every server it contributes, with a real disabledSource', () => {
	const { home, projectRoot } = makeFixture('plugin-disabled');
	const pluginDir = path.join(home, '.codex', 'plugins', 'cache', 'mkt', 'demo', '1.0.0');
	writeJson(path.join(pluginDir, '.codex-plugin', 'plugin.json'), {
		name: 'demo',
		mcpServers: { helper: { command: 'run' } },
	});
	writeConfigToml(home, ''); // plugin never enabled

	const result = scanCodexMcpServers({ home, projectRoot });
	const row = result.servers.find((s) => s.scope === 'plugin');
	assert.equal(row.disabled, true);
	assert.equal(row.disabledSource, 'not in config.toml');
});

test('a [plugins.<key>.mcp_servers.<id>] override in config.toml disables one server without needing the plugin itself disabled', () => {
	const { home, projectRoot } = makeFixture('plugin-override');
	const pluginDir = path.join(home, '.codex', 'plugins', 'cache', 'mkt', 'demo', '1.0.0');
	writeJson(path.join(pluginDir, '.codex-plugin', 'plugin.json'), {
		name: 'demo',
		mcpServers: { helper: { command: 'run' } },
	});
	writeConfigToml(
		home,
		['[plugins."demo@mkt"]', 'enabled = true', '', '[plugins."demo@mkt".mcp_servers.helper]', 'enabled = false'].join(
			'\n',
		),
	);

	const result = scanCodexMcpServers({ home, projectRoot });
	const row = result.servers.find((s) => s.scope === 'plugin');
	assert.equal(row.disabled, true);
	assert.match(row.disabledSource, /config\.toml:\d+$/);
});

test('missing config.toml and empty plugin cache yield no servers, no throw', () => {
	const { home, projectRoot } = makeFixture('missing-everything');
	const result = scanCodexMcpServers({ home, projectRoot });
	assert.deepEqual(result.servers, []);
	assert.ok(Array.isArray(result.sources));
	assert.ok(result.sources.length > 0);
});

test('guarded reality check: the real ~/.codex config.toml has at least 7 MCP servers', () => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex', 'config.toml')) || !fs.existsSync(projectRoot)) {
		return;
	}

	const result = scanCodexMcpServers({ home, projectRoot });
	const userAndProject = result.servers.filter((s) => s.scope === 'user' || s.scope === 'project');
	assert.ok(userAndProject.length >= 7, `expected >= 7 user/project MCP servers, got ${userAndProject.length}`);
	for (const server of result.servers) {
		assert.ok(server.name, 'every server row must have a name');
		assert.ok(Array.isArray(server.envKeys));
		const serialized = JSON.stringify(server);
		assert.ok(
			!/sk-[A-Za-z0-9._-]{16,}/.test(serialized),
			'no OpenAI/Anthropic-shaped secret should ever leak into a row',
		);
	}
});
