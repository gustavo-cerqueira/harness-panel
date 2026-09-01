import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_ATTACHMENT_TYPES, scanInjectedContext } from '../lib/injected-context.mjs';

// Transcript scaffolding writes to a temp dir only. The module under test
// never writes anywhere; it only reads what a session already captured.

function makeHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-injected-home-'));
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

function hookLine({ type, hookName, hookEvent, content, durationMs, timestamp }) {
	return {
		parentUuid: null,
		isSidechain: false,
		timestamp: timestamp ?? new Date().toISOString(),
		attachment: { type, hookName, hookEvent, content, durationMs: durationMs ?? null },
	};
}

test('HOOK_ATTACHMENT_TYPES lists the recognised hook attachment shapes', () => {
	assert.ok(Array.isArray(HOOK_ATTACHMENT_TYPES));
	assert.ok(HOOK_ATTACHMENT_TYPES.includes('hook_success'));
	assert.ok(HOOK_ATTACHMENT_TYPES.includes('hook_additional_context'));
	assert.ok(HOOK_ATTACHMENT_TYPES.includes('hook_system_message'));
});

test('the base system prompt is honestly reported as unavailable, never fabricated', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/demo';
	writeTranscript(home, cwd, 'sess-1', [
		hookLine({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'hi' }),
	]);
	const result = scanInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.baseSystemPrompt.available, false);
	assert.match(result.baseSystemPrompt.reason, /not readable from disk|internal to Claude Code/i);
});

test('finds the sanitized project directory for the exact cwd (slashes and dots both become dashes)', () => {
	const home = makeHome();
	const cwd = '/Users/tester.name/projects/my.app';
	const expectedDir = path.join(home, '.claude', 'projects', '-Users-tester-name-projects-my-app');
	writeTranscript(home, cwd, 'sess-1', [
		hookLine({
			type: 'hook_success',
			hookName: 'SessionStart:startup',
			hookEvent: 'SessionStart',
			content: 'session start output',
		}),
	]);

	const result = scanInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.scanned.directory, expectedDir);
	assert.equal(result.scanned.fallback, false);
	assert.equal(result.sessionStartOutput.length, 1);
	assert.equal(result.sessionStartOutput[0].text, 'session start output');
	assert.equal(result.sessionStartOutput[0].source, 'transcript');
	assert.equal(result.sessionStartOutput[0].transcriptPath, path.join(expectedDir, 'sess-1.jsonl'));
});

test('falls back to scanning all project directories when the exact one is absent, and says so', () => {
	const home = makeHome();
	const otherCwd = '/Users/tester/projects/other-project';
	writeTranscript(home, otherCwd, 'sess-other', [
		hookLine({
			type: 'hook_success',
			hookName: 'SessionStart:startup',
			hookEvent: 'SessionStart',
			content: 'fallback capture',
		}),
	]);

	const missingCwd = '/Users/tester/projects/never-opened-here';
	const result = scanInjectedContext({ home, projectRoot: missingCwd });

	assert.equal(result.scanned.fallback, true);
	assert.equal(result.scanned.directory, path.join(home, '.claude', 'projects'));
	assert.equal(result.sessionStartOutput.length, 1);
	assert.equal(result.sessionStartOutput[0].text, 'fallback capture');
});

test('separates SessionStart output from UserPromptSubmit output by real hookEvent', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/split';
	writeTranscript(home, cwd, 'sess-1', [
		hookLine({
			type: 'hook_success',
			hookName: 'SessionStart:startup',
			hookEvent: 'SessionStart',
			content: 'start text',
		}),
		hookLine({
			type: 'hook_additional_context',
			hookName: 'UserPromptSubmit',
			hookEvent: 'UserPromptSubmit',
			content: ['prompt text'],
		}),
	]);

	const result = scanInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.sessionStartOutput.length, 1);
	assert.equal(result.sessionStartOutput[0].text, 'start text');
	assert.equal(result.userPromptSubmitOutput.length, 1);
	// content as an array of strings is joined into one readable text block
	assert.equal(result.userPromptSubmitOutput[0].text, 'prompt text');
});

test('a malformed JSONL line is skipped, never fatal to the whole transcript', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/broken-line';
	const dir = path.join(home, '.claude', 'projects', sanitizedDirFor(cwd));
	fs.mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify(
			hookLine({
				type: 'hook_success',
				hookName: 'SessionStart:startup',
				hookEvent: 'SessionStart',
				content: 'before the break',
			}),
		),
		'{this is not valid json,,,',
		JSON.stringify(
			hookLine({
				type: 'hook_success',
				hookName: 'SessionStart:startup',
				hookEvent: 'SessionStart',
				content: 'after the break',
			}),
		),
	];
	fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), lines.join('\n') + '\n');

	const result = scanInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.sessionStartOutput.length, 2);
	assert.deepEqual(
		result.sessionStartOutput.map((c) => c.text),
		['before the break', 'after the break'],
	);
});

test('captured text is capped at 8000 characters and flagged truncated', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/huge';
	const huge = 'x'.repeat(9000);
	writeTranscript(home, cwd, 'sess-1', [
		hookLine({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: huge }),
	]);

	const result = scanInjectedContext({ home, projectRoot: cwd });
	const capture = result.sessionStartOutput[0];
	assert.equal(capture.text.length, 8000);
	assert.equal(capture.truncated, true);
	assert.equal(capture.bytes, 9000);
});

test('short captured text is not marked truncated', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/small';
	writeTranscript(home, cwd, 'sess-1', [
		hookLine({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'short' }),
	]);

	const result = scanInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.sessionStartOutput[0].truncated, false);
	assert.equal(result.sessionStartOutput[0].bytes, 5);
});

test('a secret inside captured hook text is redacted before it leaves the module', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/secret';
	const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234';
	writeTranscript(home, cwd, 'sess-1', [
		hookLine({
			type: 'hook_additional_context',
			hookName: 'UserPromptSubmit',
			hookEvent: 'UserPromptSubmit',
			content: [`exported ANTHROPIC_API_KEY=${secret}`],
		}),
	]);

	const result = scanInjectedContext({ home, projectRoot: cwd });
	const capture = result.userPromptSubmitOutput[0];
	assert.equal(capture.text.includes(secret), false);
	assert.equal(capture.text.includes('abcdefghijklmnop'), false);
	assert.match(capture.text, /sk-…1234/);
});

test('non-hook attachment types are ignored, never mistaken for injected context', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/other-attachments';
	writeTranscript(home, cwd, 'sess-1', [
		{
			parentUuid: null,
			timestamp: new Date().toISOString(),
			attachment: { type: 'skill_listing', hookEvent: 'SessionStart', content: 'not a hook output' },
		},
		hookLine({
			type: 'hook_success',
			hookName: 'SessionStart:startup',
			hookEvent: 'SessionStart',
			content: 'the real one',
		}),
	]);

	const result = scanInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.sessionStartOutput.length, 1);
	assert.equal(result.sessionStartOutput[0].text, 'the real one');
});

test('limitSessions bounds how many transcripts are read, taking the most recently modified', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/many-sessions';
	const now = Date.now();
	writeTranscript(
		home,
		cwd,
		'sess-old',
		[
			hookLine({
				type: 'hook_success',
				hookName: 'SessionStart:startup',
				hookEvent: 'SessionStart',
				content: 'old session',
			}),
		],
		{ mtimeMs: now - 100000 },
	);
	writeTranscript(
		home,
		cwd,
		'sess-new',
		[
			hookLine({
				type: 'hook_success',
				hookName: 'SessionStart:startup',
				hookEvent: 'SessionStart',
				content: 'new session',
			}),
		],
		{ mtimeMs: now },
	);

	const result = scanInjectedContext({ home, projectRoot: cwd, limitSessions: 1 });
	assert.equal(result.scanned.files, 1);
	assert.equal(result.sessionStartOutput.length, 1);
	assert.equal(result.sessionStartOutput[0].text, 'new session');
});

test('a project directory with no transcripts at all yields empty, honest output', () => {
	const home = makeHome();
	fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
	const result = scanInjectedContext({ home, projectRoot: '/Users/tester/projects/never-existed' });
	assert.deepEqual(result.sessionStartOutput, []);
	assert.deepEqual(result.userPromptSubmitOutput, []);
	assert.equal(result.scanned.files, 0);
});

test('outputStyle reports honestly when no style is configured anywhere in the cascade', () => {
	const home = makeHome();
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-injected-project-'));
	fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
	const result = scanInjectedContext({ home, projectRoot });
	assert.equal(result.outputStyle.exists, false);
});

test('outputStyle resolves the configured name to a real file under output-styles/', () => {
	const home = makeHome();
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-injected-project-'));
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'terse' }));
	const stylesDir = path.join(home, '.claude', 'output-styles');
	fs.mkdirSync(stylesDir, { recursive: true });
	fs.writeFileSync(path.join(stylesDir, 'terse.md'), '# Terse\nBe brief.\n');

	const result = scanInjectedContext({ home, projectRoot });
	assert.equal(result.outputStyle.name, 'terse');
	assert.equal(result.outputStyle.exists, true);
	assert.equal(result.outputStyle.content, '# Terse\nBe brief.\n');
	assert.ok(result.outputStyle.link.startsWith('vscode://file'));
});

test('throws a clear error when home or projectRoot is missing, rather than silently scanning the wrong place', () => {
	assert.throws(() => scanInjectedContext({ projectRoot: '/x' }), TypeError);
	assert.throws(() => scanInjectedContext({ home: '/x' }), TypeError);
});

test('outputStyle falls back to the project directory when the name is absent from the user directory', () => {
	const home = makeHome();
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-injected-project-'));
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'concise' }));
	const projectStylesDir = path.join(projectRoot, '.claude', 'output-styles');
	fs.mkdirSync(projectStylesDir, { recursive: true });
	fs.writeFileSync(path.join(projectStylesDir, 'concise.md'), '# Concise\nSay less.\n');

	const result = scanInjectedContext({ home, projectRoot });
	assert.equal(result.outputStyle.name, 'concise');
	assert.equal(result.outputStyle.exists, true);
	assert.equal(result.outputStyle.path, path.join(projectStylesDir, 'concise.md'));
	assert.equal(result.outputStyle.content, '# Concise\nSay less.\n');
});

test('outputStyle resolves from an ENABLED plugin cache output-styles directory when absent from user and project dirs', () => {
	const home = makeHome();
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-injected-project-'));
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.writeFileSync(
		path.join(home, '.claude', 'settings.json'),
		JSON.stringify({
			outputStyle: 'basic-memory',
			enabledPlugins: { 'basic-memory@thedotmack': true },
		}),
	);
	const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'basic-memory', '1.0.0');
	fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
	fs.writeFileSync(
		path.join(pluginDir, '.claude-plugin', 'plugin.json'),
		JSON.stringify({ name: 'basic-memory', version: '1.0.0' }),
	);
	const pluginStylesDir = path.join(pluginDir, 'output-styles');
	fs.mkdirSync(pluginStylesDir, { recursive: true });
	fs.writeFileSync(path.join(pluginStylesDir, 'basic-memory.md'), '# BM style\nFrom the plugin cache.\n');

	const result = scanInjectedContext({ home, projectRoot });
	assert.equal(result.outputStyle.name, 'basic-memory');
	assert.equal(result.outputStyle.exists, true);
	assert.equal(result.outputStyle.path, path.join(pluginStylesDir, 'basic-memory.md'));
	assert.equal(result.outputStyle.content, '# BM style\nFrom the plugin cache.\n');
});

test('outputStyle ignores a DISABLED plugin copy and reports absent only when no copy exists anywhere', () => {
	const home = makeHome();
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-injected-project-'));
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.writeFileSync(
		path.join(home, '.claude', 'settings.json'),
		JSON.stringify({
			outputStyle: 'ghost-style',
			enabledPlugins: { 'ghost@mkt': false },
		}),
	);
	const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'ghost', '1.0.0');
	fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
	fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ghost' }));
	const pluginStylesDir = path.join(pluginDir, 'output-styles');
	fs.mkdirSync(pluginStylesDir, { recursive: true });
	fs.writeFileSync(path.join(pluginStylesDir, 'ghost-style.md'), '# Should not be found\n');

	const result = scanInjectedContext({ home, projectRoot });
	assert.equal(result.outputStyle.name, 'ghost-style');
	assert.equal(result.outputStyle.exists, false);
	assert.equal(result.outputStyle.content, null);
});

test('outputStyle cascade order is user < project < plugin cache, first hit wins', () => {
	const home = makeHome();
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-injected-project-'));
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.writeFileSync(
		path.join(home, '.claude', 'settings.json'),
		JSON.stringify({
			outputStyle: 'shared-name',
			enabledPlugins: { 'plug@mkt': true },
		}),
	);
	const projectStylesDir = path.join(projectRoot, '.claude', 'output-styles');
	fs.mkdirSync(projectStylesDir, { recursive: true });
	fs.writeFileSync(path.join(projectStylesDir, 'shared-name.md'), 'project copy wins\n');

	const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0');
	fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
	fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'plug' }));
	const pluginStylesDir = path.join(pluginDir, 'output-styles');
	fs.mkdirSync(pluginStylesDir, { recursive: true });
	fs.writeFileSync(path.join(pluginStylesDir, 'shared-name.md'), 'plugin copy loses\n');

	const result = scanInjectedContext({ home, projectRoot });
	assert.equal(result.outputStyle.content, 'project copy wins\n');
	assert.equal(result.outputStyle.path, path.join(projectStylesDir, 'shared-name.md'));
});

test('the fallback transcript scan follows a symlinked project directory whose target is a real directory', () => {
	const home = makeHome();
	const realDir = path.join(home, '.claude', 'real-project-dir');
	fs.mkdirSync(realDir, { recursive: true });
	fs.writeFileSync(
		path.join(realDir, 'sess-1.jsonl'),
		JSON.stringify(
			hookLine({
				type: 'hook_success',
				hookName: 'SessionStart:startup',
				hookEvent: 'SessionStart',
				content: 'via symlinked project dir',
			}),
		) + '\n',
	);
	const transcriptsRoot = path.join(home, '.claude', 'projects');
	fs.mkdirSync(transcriptsRoot, { recursive: true });
	fs.symlinkSync(realDir, path.join(transcriptsRoot, '-Users-tester-symlinked'));

	const result = scanInjectedContext({ home, projectRoot: '/Users/tester/never-opened-here' });
	assert.equal(result.scanned.fallback, true);
	assert.equal(result.sessionStartOutput.length, 1);
	assert.equal(result.sessionStartOutput[0].text, 'via symlinked project dir');
});

test('unrecognized attachment types raise a loud format-drift note instead of a silently empty section', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/demo-drift';
	writeTranscript(home, cwd, 'sess-drift', [
		hookLine({ type: 'hook_shiny_new_shape', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'hi' }),
		hookLine({ type: 'hook_other_unknown', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', content: 'yo' }),
	]);
	const result = scanInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.sessionStartOutput.length, 0);
	assert.ok(
		result.notes.some((note) => /format may have changed|unrecognized attachment/i.test(note)),
		`expected a drift note, got: ${JSON.stringify(result.notes)}`,
	);
	assert.ok(result.notes.some((note) => note.includes('hook_shiny_new_shape')));
});

test('recognized captures raise no drift note', () => {
	const home = makeHome();
	const cwd = '/Users/tester/projects/demo-ok';
	writeTranscript(home, cwd, 'sess-ok', [
		hookLine({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'hi' }),
	]);
	const result = scanInjectedContext({ home, projectRoot: cwd });
	assert.equal(result.sessionStartOutput.length, 1);
	assert.equal(result.notes.some((note) => /format may have changed/i.test(note)), false);
});
