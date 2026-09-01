import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCommands } from '../lib/commands-scan.mjs';

// Test scaffolding writes to a temp dir only; the library under test never
// writes, mirroring the guarantee asserted in test/source-file.test.mjs.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-commands-'));
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project');

function write(absPath, content) {
	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, content);
}

// --- user layer: <home>/.claude/commands/**/*.md ---------------------------
// frontmatter present, with disable-model-invocation: true
write(
	path.join(HOME, '.claude', 'commands', 'ez_self-review.md'),
	[
		'---',
		'description: Periodic self-review of Claude Code CLI configuration',
		"argument-hint: '[--dry-run]'",
		'disable-model-invocation: true',
		'allowed-tools: Read, Glob, Grep',
		'---',
		'',
		'Run the self review.',
		'',
	].join('\n'),
);

// --- project layer: <projectRoot>/.claude/commands/**/*.md -----------------
// no frontmatter at all: must default, not error
write(path.join(PROJECT, '.claude', 'commands', 'ez_backend-dev.md'), '# Backend Development\n\nStart the backend.\n');

// nested subdirectory: commands/opsx/apply.md -> command "opsx:apply"
write(
	path.join(PROJECT, '.claude', 'commands', 'opsx', 'apply.md'),
	[
		'---',
		'name: "OPSX: Apply"',
		'description: Implement tasks from an OpenSpec change (Experimental)',
		'---',
		'',
		'Implement tasks.',
		'',
	].join('\n'),
);

const result = scanCommands({ home: HOME, projectRoot: PROJECT });

test('scanCommands returns commands plus notes, never throws', () => {
	assert.ok(Array.isArray(result.commands));
	assert.ok(Array.isArray(result.notes));
});

test('a command with full frontmatter parses description, argument-hint, allowed-tools and disable-model-invocation', () => {
	const row = result.commands.find((c) => c.name === 'ez_self-review');
	assert.ok(row, 'expected the user-layer command to be present');
	assert.equal(row.layer, 'user');
	assert.equal(row.description, 'Periodic self-review of Claude Code CLI configuration');
	assert.equal(row.argumentHint, '[--dry-run]');
	assert.equal(row.disableModelInvocation, true);
	assert.equal(row.allowedTools, 'Read, Glob, Grep');
	assert.equal(row.line, 1);
	assert.ok(row.path.endsWith(path.join('.claude', 'commands', 'ez_self-review.md')));
	assert.equal(row.link, `vscode://file${row.path}:1`);
	assert.equal(row.error, null);
	assert.ok(row.bytes > 0);
});

test('a command with no frontmatter block gets all-defaults, not an error', () => {
	const row = result.commands.find((c) => c.name === 'ez_backend-dev');
	assert.ok(row, 'expected the project-layer command to be present');
	assert.equal(row.layer, 'project');
	assert.equal(row.description, null);
	assert.equal(row.argumentHint, null);
	assert.equal(row.allowedTools, null);
	assert.equal(row.disableModelInvocation, false);
	assert.equal(row.error, null);
});

test('a nested command directory produces a namespaced command name', () => {
	const row = result.commands.find((c) => c.name === 'opsx:apply');
	assert.ok(row, 'expected commands/opsx/apply.md to become the command "opsx:apply"');
	assert.equal(row.layer, 'project');
	assert.equal(row.description, 'Implement tasks from an OpenSpec change (Experimental)');
	// "name:" in frontmatter is a display title, not the addressable command name;
	// the addressable name always comes from the file path.
	assert.notEqual(row.name, 'OPSX: Apply');
});

test('disable-model-invocation defaults to false when the key is absent', () => {
	const row = result.commands.find((c) => c.name === 'opsx:apply');
	assert.equal(row.disableModelInvocation, false);
});

test('an absent commands directory yields an empty list plus a recorded note, never a throw', () => {
	const emptyHome = path.join(TMP, 'home-with-no-commands-dir');
	const emptyProject = path.join(TMP, 'project-with-no-commands-dir');
	fs.mkdirSync(emptyHome, { recursive: true });
	fs.mkdirSync(emptyProject, { recursive: true });
	let out;
	assert.doesNotThrow(() => {
		out = scanCommands({ home: emptyHome, projectRoot: emptyProject });
	});
	assert.equal(out.commands.length, 0);
	assert.ok(out.notes.length > 0, 'a missing directory must leave a trace, not silence');
});

test('plugin commands are namespaced <plugin>:<name> from the marketplace/plugin/version cache layout', () => {
	const pluginHome = path.join(TMP, 'home-with-plugin');
	write(
		path.join(pluginHome, '.claude', 'plugins', 'cache', 'openai-codex', 'codex', '1.0.6', 'commands', 'rescue.md'),
		[
			'---',
			'description: Delegate investigation to the Codex rescue subagent',
			'disable-model-invocation: false',
			'---',
			'',
			'Invoke the codex rescue subagent.',
			'',
		].join('\n'),
	);
	const emptyProject = path.join(TMP, 'project-for-plugin-test');
	fs.mkdirSync(emptyProject, { recursive: true });
	const out = scanCommands({ home: pluginHome, projectRoot: emptyProject });
	const row = out.commands.find((c) => c.name === 'codex:rescue');
	assert.ok(row, 'expected commands/rescue.md under the codex plugin to become "codex:rescue"');
	assert.equal(row.layer, 'plugin');
	assert.equal(row.description, 'Delegate investigation to the Codex rescue subagent');
});

test('every command row carries an absolute path and a matching vscode link', () => {
	for (const row of result.commands) {
		assert.ok(path.isAbsolute(row.path));
		assert.equal(row.link, `vscode://file${row.path}:1`);
	}
});

test('a plugin command is stamped with its cached version and whether that version is the live one', () => {
	const home = path.join(TMP, 'home-stale-versions');
	const project = path.join(TMP, 'project-stale-versions');
	fs.mkdirSync(project, { recursive: true });
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'openai-codex', 'codex');
	for (const version of ['1.0.5', '1.0.6']) {
		write(path.join(parent, version, 'commands', 'rescue.md'), '---\ndescription: Rescue.\n---\n\nBody.\n');
	}
	fs.mkdirSync(path.join(parent, '1.0.6', '.in_use'), { recursive: true });

	const out = scanCommands({ home, projectRoot: project });
	const rows = out.commands.filter((c) => c.name === 'codex:rescue');
	// Disk truth: both cached copies are listed, and each says which it is.
	assert.equal(rows.length, 2);
	const byVersion = Object.fromEntries(rows.map((c) => [c.pluginVersion, c]));
	assert.equal(byVersion['1.0.6'].activeVersion, true);
	assert.equal(byVersion['1.0.5'].activeVersion, false);
});

test('a user or project command is not version-scoped and claims neither flag', () => {
	for (const row of result.commands.filter((c) => c.layer !== 'plugin')) {
		assert.equal(row.pluginVersion, null);
		assert.equal(row.activeVersion, null, 'only a plugin row can be a stale-version copy');
	}
});
