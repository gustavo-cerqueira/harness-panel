import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexInjectedContext } from '../lib/codex/injected-context.mjs';

// Rollout scaffolding writes to a temp dir only. The module under test never
// writes anywhere; it only reads what a session rollout already recorded.

function makeHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-injected-home-'));
}

function writeRollout(home, sessionId, lines, { mtimeMs } = {}) {
	const dir = path.join(home, '.codex', 'sessions', '2026', '08', '26');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `rollout-${sessionId}.jsonl`);
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
	if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
	return file;
}

function sessionMeta({ cwd, baseInstructions, timestamp = '2026-08-26T10:00:00.000Z' }) {
	return {
		timestamp,
		type: 'session_meta',
		payload: { session_id: 's1', cwd, cli_version: '0.149.1', base_instructions: baseInstructions },
	};
}

function turnContext({
	timestamp = '2026-08-26T10:05:00.000Z',
	model = 'gpt-5.6-sol',
	effort = 'xhigh',
	approvalPolicy = 'never',
	sandboxPolicy = { type: 'read-only' },
	permissionProfile = { type: 'managed' },
	collaborationMode = { mode: 'default', settings: { model, reasoning_effort: effort } },
	personality = 'pragmatic',
	serviceTier = null,
} = {}) {
	return {
		timestamp,
		type: 'turn_context',
		payload: {
			model,
			effort,
			approval_policy: approvalPolicy,
			sandbox_policy: sandboxPolicy,
			permission_profile: permissionProfile,
			collaboration_mode: collaborationMode,
			personality,
			service_tier: serviceTier,
		},
	};
}

function worldState({ timestamp = '2026-08-26T10:01:00.000Z', agentsMd, skills, pluginsInstructions }) {
	return {
		timestamp,
		type: 'world_state',
		payload: { state: { agents_md: agentsMd, skills, plugins_instructions: pluginsInstructions } },
	};
}

function devMessage({ timestamp = '2026-08-26T10:02:00.000Z', blocks }) {
	return {
		timestamp,
		type: 'response_item',
		payload: { type: 'message', role: 'developer', content: blocks.map((text) => ({ type: 'input_text', text })) },
	};
}

function userMessage({ timestamp = '2026-08-26T10:00:01.000Z', blocks }) {
	return {
		timestamp,
		type: 'response_item',
		payload: { type: 'message', role: 'user', content: blocks.map((text) => ({ type: 'input_text', text })) },
	};
}

test('the base system prompt is honestly reported as unavailable when no rollout recorded it', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/demo';
	writeRollout(home, 's1', [sessionMeta({ cwd, baseInstructions: undefined })]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.baseSystemPrompt.available, false);
	assert.match(result.baseSystemPrompt.reason, /no session rollout/i);
});

test('base_instructions as a {text, provenance} object is captured, provenance ignored', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/obj-base';
	writeRollout(home, 's1', [
		sessionMeta({ cwd, baseInstructions: { text: 'You are Codex.', provenance: 'packaged' } }),
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.baseSystemPrompt.available, true);
	assert.equal(result.baseSystemPrompt.textHead, 'You are Codex.');
	assert.equal(
		result.baseSystemPrompt.reason,
		'recorded base instructions (session_meta.base_instructions) — not the complete hidden system prompt: the CLI adds developer messages, tool schemas and permission context at runtime',
	);
	assert.ok(result.baseSystemPrompt.transcriptPath.endsWith('.jsonl'));
});

test('base_instructions as a plain string is also captured', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/string-base';
	writeRollout(home, 's1', [sessionMeta({ cwd, baseInstructions: 'Plain string instructions.' })]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.baseSystemPrompt.available, true);
	assert.equal(result.baseSystemPrompt.textHead, 'Plain string instructions.');
});

test('base_instructions longer than 600 chars is truncated and bytes reports the original size', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/huge-base';
	const huge = 'x'.repeat(900);
	writeRollout(home, 's1', [sessionMeta({ cwd, baseInstructions: { text: huge } })]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.baseSystemPrompt.textHead.length, 600);
	assert.equal(result.baseSystemPrompt.bytes, 900);
});

test('outputStyle reports honestly when no turn_context was scanned', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/no-turn-context';
	writeRollout(home, 's1', [sessionMeta({ cwd })]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.outputStyle.exists, false);
	assert.equal(result.outputStyle.name, 'turn context (effective runtime)');
	assert.equal(result.outputStyle.content, null);
});

test('outputStyle carries the LATEST turn_context, with collaboration_mode narrowed to its .mode string', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/turn-context';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		turnContext({ timestamp: '2026-08-26T10:05:00.000Z', model: 'gpt-early' }),
		turnContext({ timestamp: '2026-08-26T10:09:00.000Z', model: 'gpt-5.6-sol', effort: 'xhigh' }),
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.outputStyle.exists, true);
	assert.equal(result.outputStyle.line, 1);
	assert.ok(result.outputStyle.link.startsWith('vscode://file'));
	const settings = JSON.parse(result.outputStyle.content);
	assert.equal(settings.model, 'gpt-5.6-sol');
	assert.equal(settings.effort, 'xhigh');
	assert.equal(settings.collaboration_mode, 'default');
	assert.deepEqual(result.outputStyle.settings, settings);
});

test('world_state agents_md becomes a single "AGENTS.md chain (world_state)" capture carrying directory', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/agents-md';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		worldState({
			timestamp: '2026-08-26T10:01:00.000Z',
			agentsMd: { directory: cwd, text: 'Old chain text.' },
		}),
		worldState({
			timestamp: '2026-08-26T10:03:00.000Z',
			agentsMd: { directory: cwd, text: 'Newest chain text.' },
		}),
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	const rows = result.sessionStartOutput.filter((c) => c.hookName === 'AGENTS.md chain (world_state)');
	// only the LATEST world_state.agents_md is reported, never one per event
	assert.equal(rows.length, 1);
	assert.equal(rows[0].text, 'Newest chain text.');
	assert.equal(rows[0].directory, cwd);
	assert.equal(rows[0].durationMs, null);
});

test('world_state skills/plugins_instructions flags become one "catalog flags" capture', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/catalog-flags';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		worldState({ skills: { includeInstructions: true }, pluginsInstructions: true }),
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	const row = result.sessionStartOutput.find((c) => c.hookName === 'catalog flags');
	assert.ok(row);
	assert.deepEqual(JSON.parse(row.text), { skills: { includeInstructions: true }, pluginsInstructions: true });
});

test('a developer message starting with <skills_instructions> is captured with a skillCount', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/skills-catalog';
	const skillsText = [
		'<skills_instructions>',
		'## Skills',
		'### Skill roots',
		'- `r0` = `/abs/path/skills`',
		'### Available skills',
		'- imagegen: Generate or edit raster images (file: r0/imagegen/SKILL.md)',
		'- openai-docs: Use for Codex docs (file: r0/openai-docs/SKILL.md)',
	].join('\n');
	writeRollout(home, 's1', [sessionMeta({ cwd }), devMessage({ blocks: [skillsText] })]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	const row = result.sessionStartOutput.find((c) => c.hookName === '<skills_instructions>');
	assert.ok(row);
	// two `- name: description (file: ...)` rows; the roots bullet (no colon after
	// its lead word) must not be counted
	assert.equal(row.skillCount, 2);
});

test('a developer message is captured under a hookName derived from its own first line', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/basic-memory';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		devMessage({ blocks: ['# Basic Memory — session context\n\nNo active tasks.'] }),
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	const row = result.sessionStartOutput.find((c) => c.hookName === '# Basic Memory — session context');
	assert.ok(row);
	assert.equal(row.transcriptPath.endsWith('.jsonl'), true);
});

test('a developer message with MULTIPLE content blocks yields one capture PER block, not one joined capture', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/multi-block-dev';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		devMessage({
			blocks: ['<permissions instructions>\nSome permission text.', '<apps_instructions>\nSome apps text.'],
		}),
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	const names = result.sessionStartOutput.map((c) => c.hookName);
	assert.ok(names.includes('<permissions instructions>'));
	assert.ok(names.includes('<apps_instructions>'));
});

test('a user message block starting with "# AGENTS.md instructions for" is captured, even bundled alongside unrelated blocks', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/agents-user-msg';
	// Mirrors a real rollout: one user message with three unrelated content
	// blocks — a recommended-plugins block, the AGENTS.md chain block, and an
	// environment_context block. Only the middle one must be attributed here.
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		userMessage({
			blocks: [
				'<recommended_plugins>\nSome plugin list.',
				`# AGENTS.md instructions for ${cwd}\nThe combined chain text.`,
				'<environment_context>\n  <cwd>' + cwd + '</cwd>\n</environment_context>',
			],
		}),
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	const chainRow = result.sessionStartOutput.find((c) => c.hookName === 'AGENTS.md instructions (user message)');
	assert.ok(chainRow);
	assert.match(chainRow.text, /combined chain text/);

	const envRow = result.userPromptSubmitOutput.find((c) => c.hookName === 'environment context (user message)');
	assert.ok(envRow);
	assert.match(envRow.text, /environment_context/);

	// the unrelated <recommended_plugins> block must not show up as either
	assert.equal(
		result.sessionStartOutput.some((c) => /recommended_plugins/.test(c.text)),
		false,
	);
});

test('userPromptSubmitOutput keeps only the newest 10 environment_context captures, newest first', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/many-env-contexts';
	const lines = [sessionMeta({ cwd })];
	for (let i = 0; i < 12; i++) {
		const ts = `2026-08-26T10:${String(i).padStart(2, '0')}:00.000Z`;
		lines.push(userMessage({ timestamp: ts, blocks: [`<environment_context>\n  <turn>${i}</turn>`] }));
	}
	writeRollout(home, 's1', lines);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.userPromptSubmitOutput.length, 10);
	assert.match(result.userPromptSubmitOutput[0].text, /<turn>11<\/turn>/);
	assert.match(result.userPromptSubmitOutput[9].text, /<turn>2<\/turn>/);
});

test('scanned.cwdMatch is "exact" when session_meta.cwd equals projectRoot exactly', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/exact-match';
	writeRollout(home, 's1', [sessionMeta({ cwd })]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.scanned.cwdMatch, 'exact');
	assert.equal(result.scanned.sessions, 1);
	assert.equal(result.scanned.files, 1);
});

test('scanned.cwdMatch falls back to "under" when only a subdirectory cwd is found', async () => {
	const home = makeHome();
	const projectRoot = '/Users/tester/projects/monorepo';
	const subCwd = '/Users/tester/projects/monorepo/apps/backend';
	writeRollout(home, 's1', [sessionMeta({ cwd: subCwd })]);
	const result = await scanCodexInjectedContext({ home, projectRoot });
	assert.equal(result.scanned.cwdMatch, 'under');
});

test('scanned.cwdMatch falls back to "any" when nothing matches the project at all, rather than reporting nothing', async () => {
	const home = makeHome();
	writeRollout(home, 's1', [sessionMeta({ cwd: '/Users/tester/projects/unrelated' })]);
	const result = await scanCodexInjectedContext({ home, projectRoot: '/Users/tester/projects/never-opened-here' });
	assert.equal(result.scanned.cwdMatch, 'any');
	assert.equal(result.scanned.files, 1);
});

test('limitSessions bounds how many rollouts are scanned, taking the newest exact-cwd matches', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/many-sessions';
	const now = Date.now();
	writeRollout(home, 'old', [sessionMeta({ cwd }), devMessage({ blocks: ['old session marker'] })], {
		mtimeMs: now - 100000,
	});
	writeRollout(home, 'new', [sessionMeta({ cwd }), devMessage({ blocks: ['new session marker'] })], { mtimeMs: now });

	const result = await scanCodexInjectedContext({ home, projectRoot: cwd, limitSessions: 1 });
	assert.equal(result.scanned.files, 1);
	assert.ok(result.sessionStartOutput.some((c) => c.hookName === 'new session marker'));
	assert.ok(!result.sessionStartOutput.some((c) => c.hookName === 'old session marker'));
});

test('a secret inside a captured developer message is redacted before it leaves the module', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/secret-dev';
	const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234';
	writeRollout(home, 's1', [
		sessionMeta({ cwd }),
		devMessage({ blocks: [`# leaked\nexported ANTHROPIC_API_KEY=${secret}`] }),
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	const row = result.sessionStartOutput.find((c) => c.hookName === '# leaked');
	assert.ok(row);
	assert.equal(row.text.includes(secret), false);
	assert.match(row.text, /sk-…1234/);
});

test('a malformed JSONL line is skipped, never fatal to the rest of the rollout', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/broken-line';
	const dir = path.join(home, '.codex', 'sessions', '2026', '08', '26');
	fs.mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify(sessionMeta({ cwd })),
		'{this is not valid json,,,',
		JSON.stringify(devMessage({ blocks: ['after the break'] })),
	];
	fs.writeFileSync(path.join(dir, 'rollout-broken.jsonl'), lines.join('\n') + '\n');

	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.ok(result.sessionStartOutput.some((c) => c.hookName === 'after the break'));
});

test('a project with no rollouts at all yields empty, honest output', async () => {
	const home = makeHome();
	fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
	const result = await scanCodexInjectedContext({ home, projectRoot: '/Users/tester/projects/never-existed' });
	assert.deepEqual(result.sessionStartOutput, []);
	assert.deepEqual(result.userPromptSubmitOutput, []);
	assert.equal(result.scanned.files, 0);
	assert.equal(result.baseSystemPrompt.available, false);
});

test('rejects with a clear error when home or projectRoot is missing, rather than silently scanning the wrong place', async () => {
	await assert.rejects(() => scanCodexInjectedContext({ projectRoot: '/x' }), TypeError);
	await assert.rejects(() => scanCodexInjectedContext({ home: '/x' }), TypeError);
});

test('REALITY: scanning the real ~/.codex against a real project root never throws and finds recorded base instructions', async (t) => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex', 'sessions'))) {
		t.skip('no real ~/.codex/sessions on this machine');
		return;
	}
	const result = await scanCodexInjectedContext({ home, projectRoot, limitSessions: 20 });
	assert.ok(result.scanned.sessions >= 1, 'expected at least one real rollout scanned');
	assert.equal(result.baseSystemPrompt.available, true);
	assert.ok(['exact', 'under', 'any'].includes(result.scanned.cwdMatch));
});

test('unrecognized record types raise a loud format-drift note instead of a silently empty section', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/demo-drift';
	writeRollout(home, 's1', [
		{ timestamp: '2026-08-26T10:00:00.000Z', type: 'session_metadata_v2', payload: { cwd } },
		{ timestamp: '2026-08-26T10:00:01.000Z', type: 'turn_state_v2', payload: {} },
	]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.ok(
		result.notes.some((note) => /format may have changed/i.test(note)),
		`expected a drift note, got: ${JSON.stringify(result.notes)}`,
	);
	assert.ok(result.notes.some((note) => note.includes('session_metadata_v2')));
});

test('recognized records raise no drift note', async () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/demo-ok';
	writeRollout(home, 's1', [sessionMeta({ cwd })]);
	const result = await scanCodexInjectedContext({ home, projectRoot: cwd });
	assert.equal(
		result.notes.some((note) => /format may have changed/i.test(note)),
		false,
	);
});

test('a project with no rollouts at all raises no drift note (empty, not broken)', async () => {
	const home = makeHome();
	fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
	const result = await scanCodexInjectedContext({ home, projectRoot: '/Users/tester/projects/never-existed-drift' });
	assert.deepEqual(result.notes, []);
});
