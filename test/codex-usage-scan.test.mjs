import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanUsage } from '../lib/codex/usage-scan.mjs';

// Rollout scaffolding writes to a temp dir only. The module under test never
// writes anywhere; it only reads what a session rollout already recorded.

function makeHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-usage-home-'));
}

function writeRollout(home, sessionId, lines, { mtimeMs } = {}) {
	const dir = path.join(home, '.codex', 'sessions', '2026', '08', '26');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `rollout-${sessionId}.jsonl`);
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
	if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
	return file;
}

function sessionMeta({ cwd, timestamp = '2026-08-26T10:00:00.000Z' }) {
	return { timestamp, type: 'session_meta', payload: { session_id: 's1', cwd, cli_version: '0.149.1' } };
}

function mcpCall({ timestamp = '2026-08-26T10:01:00.000Z', namespace, name, args = {} }) {
	return {
		timestamp,
		type: 'response_item',
		payload: { type: 'function_call', namespace, name, arguments: JSON.stringify(args), call_id: 'call_x' },
	};
}

function spawnAgent({ timestamp = '2026-08-26T10:02:00.000Z', args }) {
	return {
		timestamp,
		type: 'response_item',
		payload: {
			type: 'function_call',
			namespace: 'collaboration',
			name: 'spawn_agent',
			arguments: typeof args === 'string' ? args : JSON.stringify(args),
			call_id: 'call_spawn',
		},
	};
}

test('MCP tool calls are counted per server (the full "mcp__<id>" namespace) AND per tool', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/mcp-demo';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		mcpCall({ namespace: 'mcp__claude_peers', name: 'set_summary' }),
		mcpCall({ namespace: 'mcp__claude_peers', name: 'set_summary' }),
		mcpCall({ namespace: 'mcp__claude_peers', name: 'send_message' }),
		mcpCall({ namespace: 'mcp__basic_memory', name: 'search_notes' }),
	]);

	const result = await scanUsage({ home, projectRoot: cwd });
	assert.equal(result.error, null);
	assert.equal(result.mcpServers.length, 2);

	const peers = result.mcpServers.find((s) => s.name === 'mcp__claude_peers');
	assert.ok(peers);
	assert.equal(peers.calls, 3);
	assert.deepEqual(
		peers.tools.map((t) => [t.name, t.calls]),
		[
			['set_summary', 2],
			['send_message', 1],
		],
	);

	const basicMemory = result.mcpServers.find((s) => s.name === 'mcp__basic_memory');
	assert.ok(basicMemory);
	assert.equal(basicMemory.calls, 1);
});

test('a spawn_agent call is counted under its arguments.agent_type', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/agent-demo';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		spawnAgent({ args: { agent_type: 'backend-nestjs-reviewer', fork_turns: 'all' } }),
		spawnAgent({ args: { agent_type: 'backend-nestjs-reviewer', fork_turns: 'all' } }),
	]);

	const result = await scanUsage({ home, projectRoot: cwd });
	assert.equal(result.subagents.length, 1);
	assert.equal(result.subagents[0].type, 'backend-nestjs-reviewer');
	assert.equal(result.subagents[0].dispatches, 2);
});

test('a spawn_agent call falls back to agent/role/name keys when agent_type is absent', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/agent-fallback-keys';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		spawnAgent({ timestamp: '2026-08-26T10:02:00.000Z', args: { role: 'explorer' } }),
	]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.equal(result.subagents[0].type, 'explorer');
});

test('a spawn_agent call with none of the known keys, unparsable arguments, or missing arguments is counted as (default)', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/agent-default';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		spawnAgent({ timestamp: '2026-08-26T10:02:00.000Z', args: { message: 'no identity key here' } }),
		spawnAgent({ timestamp: '2026-08-26T10:03:00.000Z', args: 'not valid json' }),
	]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.equal(result.subagents.length, 1);
	assert.equal(result.subagents[0].type, '(default)');
	assert.equal(result.subagents[0].dispatches, 2);
});

test('commands is always empty with a note — never a fabricated zero-count list', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/commands-note';
	writeRollout(home, 's1', [sessionMeta({ cwd })]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.deepEqual(result.commands, []);
	assert.ok(result.notes.some((n) => /custom-prompt invocation provenance/i.test(n)));
});

test('hooks is always empty with a note — Codex rollouts carry no hook execution record', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/hooks-note';
	writeRollout(home, 's1', [sessionMeta({ cwd })]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.deepEqual(result.hooks, []);
	assert.ok(result.notes.some((n) => /no hook execution record/i.test(n)));
});

test('a namespace that does not start with mcp__ and is not collaboration/spawn_agent is ignored', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/ignored-namespace';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		mcpCall({ namespace: 'shell', name: 'exec' }),
		mcpCall({ namespace: 'collaboration', name: 'wait_agent' }), // collaboration but not spawn_agent
	]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.deepEqual(result.mcpServers, []);
	assert.deepEqual(result.subagents, []);
});

test('a malformed JSONL line is skipped without throwing', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/broken-line';
	const dir = path.join(home, '.codex', 'sessions', '2026', '08', '26');
	fs.mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify(sessionMeta({ cwd })),
		'{this is not valid json,,,',
		JSON.stringify(mcpCall({ namespace: 'mcp__server', name: 'tool' })),
	];
	fs.writeFileSync(path.join(dir, 'rollout-broken.jsonl'), lines.join('\n') + '\n');

	const result = await scanUsage({ home, projectRoot: cwd });
	assert.equal(result.error, null);
	assert.equal(result.mcpServers.length, 1);
});

test('limitSessions bounds the number of rollout files actually scanned', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/many-sessions';
	const now = Date.now();
	writeRollout(home, 'old', [sessionMeta({ cwd }), mcpCall({ namespace: 'mcp__old', name: 'tool' })], {
		mtimeMs: now - 100000,
	});
	writeRollout(home, 'new', [sessionMeta({ cwd }), mcpCall({ namespace: 'mcp__new', name: 'tool' })], { mtimeMs: now });

	const result = await scanUsage({ home, projectRoot: cwd, limitSessions: 1 });
	assert.equal(result.scanned.files, 1);
	assert.equal(result.mcpServers.length, 1);
	assert.equal(result.mcpServers[0].name, 'mcp__new');
});

test('a missing sessions directory yields empty lists plus a real error, never invented counts', async () => {
	const home = makeHome(); // no .codex/sessions created at all
	const result = await scanUsage({ home, projectRoot: '/Users/tester/projects/never-opened' });
	assert.deepEqual(result.mcpServers, []);
	assert.deepEqual(result.commands, []);
	assert.deepEqual(result.subagents, []);
	assert.deepEqual(result.hooks, []);
	assert.equal(result.scanned.files, 0);
	assert.ok(typeof result.error === 'string' && result.error.length > 0);
});

test('a secret-shaped token inside an MCP tool name is redacted before it leaves the module', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/secret-tool';
	const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234';
	writeRollout(home, 's1', [sessionMeta({ cwd }), mcpCall({ namespace: 'mcp__server', name: `tool-${secret}` })]);
	const result = await scanUsage({ home, projectRoot: cwd });
	const toolName = result.mcpServers[0].tools[0].name;
	assert.equal(toolName.includes(secret), false);
	assert.match(toolName, /sk-…1234/);
});

test('lists are sorted by count descending, then by name ascending', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/sort-order';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		mcpCall({ namespace: 'mcp__zeta', name: 'tool' }),
		mcpCall({ namespace: 'mcp__alpha', name: 'tool' }),
		mcpCall({ namespace: 'mcp__alpha', name: 'tool' }),
	]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.deepEqual(
		result.mcpServers.map((s) => s.name),
		['mcp__alpha', 'mcp__zeta'],
	);
});

test('scanned reports the effective limitSessions alongside the actual session/file count', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/scanned-shape';
	writeRollout(home, 's1', [sessionMeta({ cwd })]);
	const result = await scanUsage({ home, projectRoot: cwd, limitSessions: 5 });
	assert.deepEqual(result.scanned, { sessions: 1, files: 1, limitSessions: 5 });
});

test('rejects with a clear error when home or projectRoot is missing, rather than silently scanning the wrong place', async () => {
	await assert.rejects(() => scanUsage({ projectRoot: '/x' }), TypeError);
	await assert.rejects(() => scanUsage({ home: '/x' }), TypeError);
});

test('unrecognized function-call namespaces raise a loud format-drift note instead of a silently empty section', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/usage-drift';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		mcpCall({ namespace: 'shell_v2', name: 'exec' }),
		mcpCall({ namespace: 'shell_v2', name: 'ls' }),
	]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.deepEqual(result.mcpServers, []);
	assert.deepEqual(result.subagents, []);
	assert.ok(
		result.notes.some((note) => /format may have changed/i.test(note)),
		`expected a drift note, got: ${JSON.stringify(result.notes)}`,
	);
	assert.ok(result.notes.some((note) => note.includes('shell_v2')));
});

test('recognized MCP/subagent calls raise no drift note', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/usage-ok';
	writeRollout(home, 's1', [sessionMeta({ cwd }), mcpCall({ namespace: 'mcp__demo', name: 'tool' })]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.deepEqual(
		result.notes.filter((note) => /format may have changed/i.test(note)),
		[],
	);
});

test('namespace-less local tool calls (exec_command, wait, ...) are never counted as drift candidates', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/usage-local-only';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		{
			timestamp: '2026-08-26T10:01:00.000Z',
			type: 'response_item',
			payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'call_1' },
		},
	]);
	const result = await scanUsage({ home, projectRoot: cwd });
	assert.deepEqual(result.mcpServers, []);
	assert.deepEqual(result.subagents, []);
	assert.deepEqual(
		result.notes.filter((note) => /format may have changed/i.test(note)),
		[],
	);
});

test('a missing sessions directory raises no drift note (empty machine, not broken)', async () => {
	const home = makeHome();
	const result = await scanUsage({ home, projectRoot: '/Users/tester/projects/usage-never-opened' });
	assert.deepEqual(
		result.notes.filter((note) => /format may have changed/i.test(note)),
		[],
	);
});

test('REALITY: scanning the real ~/.codex against a real project root never throws and produces plausible counts', async (t) => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex', 'sessions'))) {
		t.skip('no real ~/.codex/sessions on this machine');
		return;
	}
	const result = await scanUsage({ home, projectRoot, limitSessions: 50 });
	assert.ok(result.scanned.sessions >= 1, 'expected at least one real rollout scanned');
	assert.deepEqual(result.commands, []);
	assert.deepEqual(result.hooks, []);
	assert.ok(Array.isArray(result.mcpServers));
	assert.ok(Array.isArray(result.subagents));
	for (const server of result.mcpServers) {
		assert.ok(server.name.startsWith('mcp__'), `unexpected MCP server name shape: ${server.name}`);
	}
});
