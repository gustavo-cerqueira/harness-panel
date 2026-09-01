/**
 * `mergeUsage` — the join between what the scanners found on disk and what the
 * transcripts say actually ran.
 *
 * Every defect this function has had was a JOIN defect, invisible from either
 * side alone: slash commands counted zero because the transcript writes
 * `/name` and the scanner writes `name`; hook rows displayed a sibling
 * matcher's latency because the busiest bucket of an event was stamped onto
 * every row of that event; MCP servers that reach a session from the
 * claude.ai account had their calls dropped because no config row existed to
 * attach them to. So the merge is exported and exercised directly here rather
 * than only through a booted server.
 *
 * The fixtures below are synthetic payloads, not disk reads — this test never
 * touches the real home or repo.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeUsage } from '../server.mjs';

/** Minimal `sections` envelope: mergeUsage only ever looks at `ok` + `data`. */
const section = (data) => ({ ok: true, data });

test('commands: transcript names carry the leading slash the scanner does not', () => {
	const sections = {
		commands: section({
			commands: [{ name: 'model' }, { name: 'opsx:apply' }, { name: 'never-invoked' }],
		}),
	};
	mergeUsage(sections, {
		commands: [
			{ name: '/model', invocations: 15 },
			{ name: '/opsx:apply', invocations: 3 },
		],
	});

	const byName = new Map(sections.commands.data.commands.map((c) => [c.name, c.invocations]));
	assert.equal(byName.get('model'), 15);
	assert.equal(byName.get('opsx:apply'), 3);
	// A command nobody ran is a real zero, not a missing join.
	assert.equal(byName.get('never-invoked'), 0);
});

test('commands: a transcript name WITHOUT a slash still joins', () => {
	const sections = { commands: section({ commands: [{ name: 'model' }] }) };
	mergeUsage(sections, { commands: [{ name: 'model', invocations: 4 }] });
	assert.equal(sections.commands.data.commands[0].invocations, 4);
});

// --- hooks ---------------------------------------------------------------
// usage.hooks is keyed by (hookEvent, hookName), and hookName carries the tool
// that triggered the run as an `Event:Tool` suffix. A row may only claim a
// bucket its matcher could actually have produced.
const hookUsage = {
	hooks: [
		{
			hookName: 'PostToolUse:Bash',
			hookEvent: 'PostToolUse',
			runs: 4,
			durations: [100, 200, 300, 900],
			p50Ms: 250,
			maxMs: 900,
			timedOut: 0,
			blocking: true,
		},
		{
			hookName: 'PostToolUse:Edit',
			hookEvent: 'PostToolUse',
			runs: 2,
			durations: [10, 20],
			p50Ms: 15,
			maxMs: 20,
			timedOut: 1,
			blocking: true,
		},
		{
			hookName: 'PostToolUse:Write',
			hookEvent: 'PostToolUse',
			runs: 2,
			durations: [30, 40],
			p50Ms: 35,
			maxMs: 40,
			timedOut: 0,
			blocking: true,
		},
	],
};

function mergeHookRows(rows, usage = hookUsage) {
	const sections = { hooks: section(rows) };
	mergeUsage(sections, usage);
	return sections.hooks.data;
}

test('hooks: a tool-scoped matcher gets only the buckets it could have produced', () => {
	const [bash, edits] = mergeHookRows([
		{ event: 'PostToolUse', matcher: 'Bash' },
		{ event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit' },
	]);

	assert.equal(bash.runs, 4);
	assert.equal(bash.p50Ms, 250);
	assert.equal(bash.maxMs, 900);

	// The four Bash runs are NOT this row's; 2 + 2 Edit/Write runs are.
	assert.equal(edits.runs, 4);
	// Pooled durations [10, 20, 30, 40] -> median 25, NOT the busiest bucket's 250.
	assert.equal(edits.p50Ms, 25);
	assert.equal(edits.maxMs, 40);
	assert.equal(edits.timedOut, 1);
});

test('hooks: a row whose matcher covers every bucket shows the EVENT total', () => {
	const [all] = mergeHookRows([{ event: 'PostToolUse', matcher: null }]);
	assert.equal(all.runs, 8);
	// Pooled across all three buckets: [10,20,30,40,100,200,300,900] -> (40+100)/2.
	assert.equal(all.p50Ms, 70);
	assert.equal(all.maxMs, 900);
	assert.equal(all.timedOut, 1);
	assert.match(all.timingScope, /event total/);
});

test('hooks: `*` and an empty matcher mean every tool, same as no matcher', () => {
	const [star, empty] = mergeHookRows([
		{ event: 'PostToolUse', matcher: '*' },
		{ event: 'PostToolUse', matcher: '' },
	]);
	assert.equal(star.runs, 8);
	assert.equal(empty.runs, 8);
});

test('hooks: a matcher no bucket matches reports no runs, never a borrowed number', () => {
	const [glob] = mergeHookRows([{ event: 'PostToolUse', matcher: 'Glob' }]);
	assert.equal(glob.runs, null);
	assert.equal(glob.p50Ms, null);
	assert.equal(glob.maxMs, null);
	assert.equal(glob.timingScope, 'no runs recorded for this matcher');
});

test('hooks: an event with no bucket at all reports no runs', () => {
	const [stop] = mergeHookRows([{ event: 'Stop', matcher: null }]);
	assert.equal(stop.runs, null);
	assert.equal(stop.timingScope, 'no runs recorded for this matcher');
	// `blocking` is a property of the EVENT, knowable with zero runs recorded.
	assert.equal(stop.blocking, false);
});

test('hooks: timingScope names what the number covers, including how many share it', () => {
	const [edits, alsoEdits, bash] = mergeHookRows([
		{ event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit' },
		{ event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit' },
		{ event: 'PostToolUse', matcher: 'Bash' },
	]);

	assert.match(edits.timingScope, /matcher Edit\|Write\|MultiEdit only/);
	assert.match(edits.timingScope, /shared with 1 other hook/);
	assert.equal(edits.sharedWith, 2);
	assert.equal(alsoEdits.sharedWith, 2);

	// Bash overlaps neither of them, so nothing is shared with it.
	assert.equal(bash.sharedWith, 1);
	assert.equal(bash.timingScope, 'matcher Bash only');
});

test('hooks: an event-total row names the hooks it shares the total with', () => {
	const [all] = mergeHookRows([
		{ event: 'PostToolUse', matcher: null },
		{ event: 'PostToolUse', matcher: 'Bash' },
	]);
	assert.match(all.timingScope, /event total/);
	assert.match(all.timingScope, /shared with 1 other hook/);
	assert.equal(all.sharedWith, 2);
});

test('hooks: one matched bucket without pooled durations keeps its own p50', () => {
	const [row] = mergeHookRows([{ event: 'PreToolUse', matcher: 'Read' }], {
		hooks: [{ hookName: 'PreToolUse:Read', hookEvent: 'PreToolUse', runs: 3, p50Ms: 281, maxMs: 907, timedOut: 0 }],
	});
	assert.equal(row.runs, 3);
	assert.equal(row.p50Ms, 281);
	assert.equal(row.maxMs, 907);
});

// --- mcp -----------------------------------------------------------------
test('mcp: a configured server is joined on its normalized name', () => {
	const sections = {
		mcp: section({ servers: [{ name: 'claude-mem', normalizedName: 'plugin_claude-mem_mcp-search' }] }),
	};
	mergeUsage(sections, {
		mcpServers: [{ name: 'plugin_claude-mem_mcp-search', calls: 7, tools: [{ name: 'search', calls: 7 }] }],
	});
	const [server] = sections.mcp.data.servers;
	assert.equal(server.calls, 7);
	assert.deepEqual(server.toolCalls, [{ name: 'search', calls: 7 }]);
});

test('mcp: a server the transcripts name and no config defines never becomes a row', () => {
	const sections = { mcp: section({ servers: [{ name: 'basic-memory', normalizedName: 'basic-memory' }] }) };
	mergeUsage(sections, {
		mcpServers: [
			{ name: 'basic-memory', calls: 3, tools: [] },
			{ name: 'claude-in-chrome', calls: 12, tools: [{ name: 'navigate', calls: 12 }] },
		],
		scanned: { oldest: '2026-08-08T23:57:48.573Z', newest: '2026-08-27T12:45:08.502Z', sessions: 50 },
	});

	// The section inventories CONFIGURATION. A server no config file defines is
	// not part of this workspace's harness, however recently it was called --
	// that is how an uninstalled app kept being listed as an MCP server.
	const servers = sections.mcp.data.servers;
	assert.equal(servers.length, 1);
	assert.equal(servers[0].name, 'basic-memory');
	assert.equal(servers[0].calls, 3);
	assert.equal(
		servers.find((server) => server.name === 'claude-in-chrome'),
		undefined,
	);

	// Not silently dropped either: the calls happened, and the note says so.
	const [note] = sections.mcp.data.notes;
	assert.match(note, /claude-in-chrome \(12 calls\)/);
	assert.match(note, /2026-08-08 to 2026-08-27/);
	assert.match(note, /not listed above/);
	assert.match(note, /\/mcp for the live list/, 'it points at the only source that knows');
});

test('mcp: a synthesised row is never invented for a server that has a config row', () => {
	const sections = {
		mcp: section({ servers: [{ name: 'zen', normalizedName: 'zen' }] }),
	};
	mergeUsage(sections, { mcpServers: [{ name: 'zen', calls: 1, tools: [] }] });
	assert.equal(sections.mcp.data.servers.length, 1);
});

// --- degradation ---------------------------------------------------------
test('a usage scan that failed adds no counters and throws nothing', () => {
	const sections = { commands: section({ commands: [{ name: 'model' }] }) };
	mergeUsage(sections, { error: 'boom', commands: [], hooks: [], mcpServers: [], subagents: [] });
	assert.equal(sections.commands.data.commands[0].invocations, undefined);
});

test('a section that errored is skipped rather than merged into', () => {
	const sections = { commands: { ok: false, error: 'nope' }, hooks: { ok: false, error: 'nope' } };
	assert.doesNotThrow(() => mergeUsage(sections, hookUsage));
});

test('a dimension the harness declares untracked stays null instead of becoming zero', () => {
	const sections = {
		commands: { ok: true, data: { commands: [{ name: 'prompts:opsx-apply', invocations: null }] } },
		mcp: { ok: true, data: { servers: [{ name: 'basic-memory', normalizedName: 'mcp__basic_memory' }] } },
		agents: { ok: true, data: { agents: [{ name: 'terra_medium' }, { name: 'never-dispatched' }] } },
	};
	mergeUsage(sections, {
		mcpServers: [],
		commands: [],
		subagents: [{ type: 'terra_medium', dispatches: 32 }],
		hooks: [],
		untracked: ['commands', 'hooks'],
		partial: ['mcpServers'],
	});
	assert.equal(sections.commands.data.commands[0].invocations, null, 'untracked must not read as zero');
	assert.equal(sections.mcp.data.servers[0].calls, null, 'partially attributable must not read as zero');
	// subagents ARE tracked, so an agent with no dispatch really did run zero times.
	assert.equal(sections.agents.data.agents[0].dispatches, 32);
	assert.equal(sections.agents.data.agents[1].dispatches, 0);
});

test('a harness that tracks every dimension still zero-fills, unchanged', () => {
	const sections = { commands: { ok: true, data: { commands: [{ name: 'review' }] } } };
	mergeUsage(sections, { mcpServers: [], commands: [{ name: '/other', invocations: 3 }], subagents: [], hooks: [] });
	assert.equal(sections.commands.data.commands[0].invocations, 0);
});

test('a single call is reported as one call, and the count is stated once', () => {
	const sections = { mcp: section({ servers: [] }) };
	mergeUsage(sections, {
		mcpServers: [{ name: '1password', calls: 1, tools: [] }],
		scanned: { oldest: '2026-08-08T23:57:48.573Z', newest: '2026-08-27T12:45:08.502Z', sessions: 50 },
	});
	assert.equal(sections.mcp.data.servers.length, 0);
	assert.match(sections.mcp.data.notes[0], /1password \(1 call\)/);
	assert.match(sections.mcp.data.notes[0], /^1 MCP server\(s\) were called/);
});
