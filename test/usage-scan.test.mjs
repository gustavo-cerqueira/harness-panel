import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanUsage } from '../lib/usage-scan.mjs';

// Transcript scaffolding writes to a temp dir only. The module under test
// never writes anywhere; it only reads what a session already captured.

function makeHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-usage-home-'));
}

function sanitizedDirFor(cwd) {
	return cwd.replace(/[/.]/g, '-');
}

function writeTranscript(home, cwd, sessionId, lines, { mtimeMs } = {}) {
	const dir = path.join(home, '.claude', 'projects', sanitizedDirFor(cwd));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${sessionId}.jsonl`);
	fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
	if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
	return file;
}

function assistantToolUse(name, input = {}) {
	return {
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
	};
}

function userCommand(name) {
	return {
		type: 'user',
		message: { role: 'user', content: `<command-message>x</command-message>\n<command-name>${name}</command-name>` },
	};
}

function hookAttachment({ type, hookName, hookEvent, durationMs, timedOut }) {
	return {
		type: 'attachment',
		attachment: { type, hookName, hookEvent, durationMs: durationMs ?? null, timedOut: timedOut ?? null },
	};
}

test('MCP tool calls are counted per server AND per tool', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/mcp-demo';
	writeTranscript(home, cwd, 'sess-1', [
		assistantToolUse('mcp__playwright__browser_navigate', { url: 'https://example.com' }),
		assistantToolUse('mcp__playwright__browser_navigate', { url: 'https://example.com/2' }),
		assistantToolUse('mcp__playwright__browser_click', {}),
		assistantToolUse('mcp__claude-peers__send_message', {}),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		assert.equal(result.error, null);
		assert.equal(result.mcpServers.length, 2);

		const playwright = result.mcpServers.find((s) => s.name === 'playwright');
		assert.ok(playwright);
		assert.equal(playwright.calls, 3);
		assert.deepEqual(
			playwright.tools.map((t) => [t.name, t.calls]),
			[
				['browser_navigate', 2],
				['browser_click', 1],
			],
		);

		const peers = result.mcpServers.find((s) => s.name === 'claude-peers');
		assert.ok(peers);
		assert.equal(peers.calls, 1);

		assert.equal(result.totals.mcpCalls, 4);
	});
});

test('a subagent dispatch with an explicit subagent_type is counted under that type', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/agent-demo';
	writeTranscript(home, cwd, 'sess-1', [
		assistantToolUse('Agent', { subagent_type: 'general-purpose', description: 'explore' }),
		assistantToolUse('Agent', { subagent_type: 'general-purpose', description: 'explore again' }),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		assert.equal(result.subagents.length, 1);
		assert.equal(result.subagents[0].type, 'general-purpose');
		assert.equal(result.subagents[0].dispatches, 2);
		assert.equal(result.totals.subagentDispatches, 2);
	});
});

test('a subagent dispatch with no subagent_type is counted as (default)', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/agent-default';
	writeTranscript(home, cwd, 'sess-1', [assistantToolUse('Agent', { description: 'no type given' })]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		assert.equal(result.subagents.length, 1);
		assert.equal(result.subagents[0].type, '(default)');
		assert.equal(result.subagents[0].dispatches, 1);
	});
});

test('a slash command invocation is counted by name', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/command-demo';
	writeTranscript(home, cwd, 'sess-1', [userCommand('/doctor'), userCommand('/doctor'), userCommand('/compact')]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		assert.equal(result.commands.length, 2);
		assert.deepEqual(
			result.commands.map((c) => [c.name, c.invocations]),
			[
				['/doctor', 2],
				['/compact', 1],
			],
		);
		assert.equal(result.totals.commandInvocations, 3);
	});
});

test('hook p50 and max are computed correctly from recorded durations', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/hook-timing';
	writeTranscript(home, cwd, 'sess-1', [
		hookAttachment({ type: 'hook_success', hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse', durationMs: 100 }),
		hookAttachment({ type: 'hook_success', hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse', durationMs: 200 }),
		hookAttachment({ type: 'hook_success', hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse', durationMs: 300 }),
		hookAttachment({ type: 'hook_success', hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse', durationMs: 400 }),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		const row = result.hooks.find((h) => h.hookName === 'PostToolUse:Bash');
		assert.ok(row);
		assert.equal(row.runs, 4);
		// even count -> average of the two middle values: (200 + 300) / 2
		assert.equal(row.p50Ms, 250);
		assert.equal(row.maxMs, 400);
	});
});

test('hook rows carry the raw durations, sorted, so several buckets can be pooled into one median', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/hook-durations';
	writeTranscript(home, cwd, 'sess-1', [
		hookAttachment({ type: 'hook_success', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', durationMs: 300 }),
		hookAttachment({ type: 'hook_success', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', durationMs: 100 }),
		hookAttachment({ type: 'hook_success', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', durationMs: 200 }),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		const row = result.hooks.find((h) => h.hookName === 'PostToolUse:Edit');
		assert.ok(row);
		// A median of medians is a statistic of a statistic. One hook row in the
		// panel can cover several of these buckets, so the raw samples have to
		// survive the scan for the merge to pool them honestly.
		assert.deepEqual(row.durations, [100, 200, 300]);
	});
});

test('a hook run with no durationMs contributes a run but no duration sample', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/hook-no-duration';
	writeTranscript(home, cwd, 'sess-1', [
		hookAttachment({ type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', durationMs: 50 }),
		hookAttachment({ type: 'hook_error_during_execution', hookName: 'Stop', hookEvent: 'Stop' }),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		const row = result.hooks.find((h) => h.hookName === 'Stop');
		assert.equal(row.runs, 2);
		assert.deepEqual(row.durations, [50]);
	});
});

test('a hook_cancelled entry with timedOut:true is counted as a run, counted in timedOut, and included in timing', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/hook-timeout';
	writeTranscript(home, cwd, 'sess-1', [
		hookAttachment({ type: 'hook_success', hookName: 'PreToolUse:Guard', hookEvent: 'PreToolUse', durationMs: 100 }),
		hookAttachment({
			type: 'hook_cancelled',
			hookName: 'PreToolUse:Guard',
			hookEvent: 'PreToolUse',
			durationMs: 5000,
			timedOut: true,
		}),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		const row = result.hooks.find((h) => h.hookName === 'PreToolUse:Guard');
		assert.ok(row);
		assert.equal(row.runs, 2);
		assert.equal(row.timedOut, 1);
		// duration floor from the timed-out cancellation is included in timing stats
		assert.equal(row.maxMs, 5000);
	});
});

test('a hook_cancelled entry WITHOUT timedOut is counted as a run but excluded from timing stats', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/hook-esc';
	writeTranscript(home, cwd, 'sess-1', [
		hookAttachment({
			type: 'hook_success',
			hookName: 'UserPromptSubmit:Notes',
			hookEvent: 'UserPromptSubmit',
			durationMs: 100,
		}),
		hookAttachment({
			type: 'hook_cancelled',
			hookName: 'UserPromptSubmit:Notes',
			hookEvent: 'UserPromptSubmit',
			durationMs: 9999,
		}),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		const row = result.hooks.find((h) => h.hookName === 'UserPromptSubmit:Notes');
		assert.ok(row);
		assert.equal(row.runs, 2);
		assert.equal(row.timedOut, 0);
		// the Esc cancellation's durationMs (9999) must not pollute timing stats
		assert.equal(row.maxMs, 100);
		assert.equal(row.p50Ms, 100);
	});
});

test('blocking is true for PostToolUse and false for SessionStart', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/hook-blocking';
	writeTranscript(home, cwd, 'sess-1', [
		hookAttachment({ type: 'hook_success', hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse', durationMs: 50 }),
		hookAttachment({
			type: 'hook_success',
			hookName: 'SessionStart:startup',
			hookEvent: 'SessionStart',
			durationMs: 50,
		}),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		const postToolUse = result.hooks.find((h) => h.hookEvent === 'PostToolUse');
		const sessionStart = result.hooks.find((h) => h.hookEvent === 'SessionStart');
		assert.equal(postToolUse.blocking, true);
		assert.equal(sessionStart.blocking, false);
	});
});

test('a malformed JSONL line is skipped without throwing', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/broken-line';
	const dir = path.join(home, '.claude', 'projects', sanitizedDirFor(cwd));
	fs.mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify(assistantToolUse('mcp__server__tool')),
		'{this is not valid json,,,',
		JSON.stringify(assistantToolUse('mcp__server__tool')),
	];
	fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), lines.join('\n') + '\n');

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		assert.equal(result.error, null);
		assert.equal(result.totals.mcpCalls, 2);
	});
});

test('limitSessions bounds the number of transcript files actually read', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/many-sessions';
	const now = Date.now();
	writeTranscript(home, cwd, 'sess-old', [assistantToolUse('mcp__old__tool')], { mtimeMs: now - 100000 });
	writeTranscript(home, cwd, 'sess-new', [assistantToolUse('mcp__new__tool')], { mtimeMs: now });

	return scanUsage({ home, projectRoot: cwd, limitSessions: 1 }).then((result) => {
		assert.equal(result.scanned.files, 1);
		assert.equal(result.scanned.truncated, true);
		assert.equal(result.mcpServers.length, 1);
		assert.equal(result.mcpServers[0].name, 'new');
	});
});

test('a missing transcripts directory yields empty lists plus a real error, never invented counts', () => {
	const home = makeHome(); // no .claude/projects created at all
	const result0 = scanUsage({ home, projectRoot: '/Users/tester/projects/never-opened' });

	return result0.then((result) => {
		assert.deepEqual(result.mcpServers, []);
		assert.deepEqual(result.commands, []);
		assert.deepEqual(result.subagents, []);
		assert.deepEqual(result.hooks, []);
		assert.equal(result.totals.mcpCalls, 0);
		assert.equal(result.scanned.files, 0);
		assert.equal(result.scanned.fallback, true);
		assert.ok(typeof result.error === 'string' && result.error.length > 0);
	});
});

test('a secret-shaped token inside a captured hook name is redacted before it leaves the module', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/secret-hook';
	const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234';
	writeTranscript(home, cwd, 'sess-1', [
		hookAttachment({
			type: 'hook_success',
			hookName: `PostToolUse:${secret}`,
			hookEvent: 'PostToolUse',
			durationMs: 10,
		}),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		assert.equal(result.hooks.length, 1);
		const name = result.hooks[0].hookName;
		assert.equal(name.includes(secret), false);
		assert.equal(name.includes('abcdefghijklmnop'), false);
		assert.match(name, /sk-…1234/);
	});
});

test('scanned reports directory, byte total, and oldest/newest session timestamps', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/scanned-report';
	writeTranscript(home, cwd, 'sess-1', [assistantToolUse('mcp__server__tool')]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		assert.equal(result.scanned.files, 1);
		assert.equal(result.scanned.sessions, 1);
		assert.ok(result.scanned.bytes > 0);
		assert.ok(typeof result.scanned.oldest === 'string');
		assert.ok(typeof result.scanned.newest === 'string');
		assert.equal(result.scanned.fallback, false);
	});
});

test('directories whose name contains claude-mem-observer-sessions are skipped during fallback scanning', () => {
	const home = makeHome();
	writeTranscript(home, '/Users/tester/.claude-mem-observer-sessions/whatever', 'sess-observer', [
		assistantToolUse('mcp__observer__tool'),
	]);
	writeTranscript(home, '/Users/tester/projects/real-work', 'sess-real', [assistantToolUse('mcp__real__tool')]);

	return scanUsage({ home, projectRoot: '/Users/tester/projects/never-opened-here' }).then((result) => {
		assert.equal(result.scanned.fallback, true);
		const names = result.mcpServers.map((s) => s.name);
		assert.ok(names.includes('real'));
		assert.ok(!names.includes('observer'));
	});
});

test('lists are sorted by count descending, then by name ascending', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/sort-order';
	writeTranscript(home, cwd, 'sess-1', [
		assistantToolUse('mcp__zeta__tool'),
		assistantToolUse('mcp__alpha__tool'),
		assistantToolUse('mcp__alpha__tool'),
	]);

	return scanUsage({ home, projectRoot: cwd }).then((result) => {
		assert.deepEqual(
			result.mcpServers.map((s) => s.name),
			['alpha', 'zeta'],
		);
	});
});

test('rejects with a clear error when home or projectRoot is missing, rather than silently scanning the wrong place', async () => {
	await assert.rejects(() => scanUsage({ projectRoot: '/x' }), TypeError);
	await assert.rejects(() => scanUsage({ home: '/x' }), TypeError);
});
