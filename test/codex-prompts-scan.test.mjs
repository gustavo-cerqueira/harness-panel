import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexPrompts } from '../lib/codex/prompts-scan.mjs';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-prompts-'));
}

function writePrompt(promptsDir, filename, content) {
	fs.mkdirSync(promptsDir, { recursive: true });
	fs.writeFileSync(path.join(promptsDir, filename), content);
}

test('reads a top-level custom prompt with frontmatter and namespaces it prompts:<stem>', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writePrompt(
		path.join(home, '.codex', 'prompts'),
		'opsx-apply.md',
		[
			'---',
			'description: Implement tasks from an OpenSpec change',
			'argument-hint: command arguments',
			'---',
			'',
			'Body text with no placeholders.',
		].join('\n'),
	);

	const { commands, notes } = scanCodexPrompts({ home, projectRoot });
	const row = commands.find((c) => c.name === 'prompts:opsx-apply');
	assert.ok(row, 'expected a prompts:opsx-apply row');
	assert.equal(row.layer, 'user');
	assert.equal(row.line, 1);
	assert.ok(row.link.startsWith('vscode://file'));
	assert.equal(row.description, 'Implement tasks from an OpenSpec change');
	assert.equal(row.argumentHint, 'command arguments');
	assert.equal(row.allowedTools, null);
	assert.equal(row.disableModelInvocation, false);
	assert.equal(row.invocations, null);
	assert.equal(row.aliasOf, null);
	assert.deepEqual(row.placeholders, []);
	assert.ok(notes.length >= 2);
	assert.ok(notes.some((n) => /0\.149\.1/.test(n)));
	assert.ok(notes.some((n) => /invocations/.test(n)));
});

test('a prompt with no frontmatter still loads with null description/argumentHint', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writePrompt(path.join(home, '.codex', 'prompts'), 'bare.md', 'Just do the thing.');

	const { commands } = scanCodexPrompts({ home, projectRoot });
	const row = commands.find((c) => c.name === 'prompts:bare');
	assert.ok(row);
	assert.equal(row.description, null);
	assert.equal(row.argumentHint, null);
});

test('detects $1..$9, $ARGUMENTS and a named $PLACEHOLDER, deduped and sorted, ignoring $$', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writePrompt(
		path.join(home, '.codex', 'prompts'),
		'templated.md',
		[
			'---',
			'description: uses placeholders',
			'---',
			'',
			'First arg is $1, then $9 again $1.',
			'All args: $ARGUMENTS.',
			'File target: $FILE.',
			'A literal dollar: $$5.',
		].join('\n'),
	);

	const { commands } = scanCodexPrompts({ home, projectRoot });
	const row = commands.find((c) => c.name === 'prompts:templated');
	assert.deepEqual(row.placeholders, ['$1', '$9', '$ARGUMENTS', '$FILE']);
});

test('only top-level prompt files are discovered -- a nested subdirectory is ignored', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const promptsDir = path.join(home, '.codex', 'prompts');
	writePrompt(promptsDir, 'top.md', '---\ndescription: top level\n---\nBody.');
	const nestedDir = path.join(promptsDir, 'nested');
	fs.mkdirSync(nestedDir, { recursive: true });
	fs.writeFileSync(path.join(nestedDir, 'deep.md'), '---\ndescription: should not appear\n---\nBody.');

	const { commands } = scanCodexPrompts({ home, projectRoot });
	assert.ok(commands.some((c) => c.name === 'prompts:top'));
	assert.ok(!commands.some((c) => c.name.includes('deep')));
});

test('appends the exact built-in registry plus aliases as their own rows', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const { commands } = scanCodexPrompts({ home, projectRoot });

	const builtins = commands.filter((c) => c.layer === 'builtin' && c.aliasOf === null);
	assert.equal(builtins.length, 55);
	for (const row of builtins) {
		assert.equal(row.path, null);
		assert.equal(row.link, null);
		assert.equal(row.invocations, null);
	}
	assert.ok(builtins.some((c) => c.name === 'model'));
	assert.ok(builtins.some((c) => c.name === 'debug-m-update'));

	const aliases = commands.filter((c) => c.aliasOf !== null);
	assert.equal(aliases.length, 3);
	const byName = Object.fromEntries(aliases.map((a) => [a.name, a.aliasOf]));
	assert.equal(byName.cwd, 'pwd');
	assert.equal(byName.pet, 'pets');
	assert.equal(byName.clean, 'stop');
});

test('an empty prompts directory yields only the built-in registry, never throws', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const { commands } = scanCodexPrompts({ home, projectRoot });
	assert.equal(commands.filter((c) => c.layer === 'user').length, 0);
	assert.ok(commands.length > 0);
});

test('guarded reality check: real ~/.codex/prompts has at least 5 prompts:opsx-* rows', () => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex', 'prompts')) || !fs.existsSync(projectRoot)) {
		return;
	}

	const { commands } = scanCodexPrompts({ home, projectRoot });
	const opsx = commands.filter((c) => c.name.startsWith('prompts:opsx-'));
	assert.ok(opsx.length >= 5, `expected >= 5 prompts:opsx-* rows, got ${opsx.length}`);
	for (const row of opsx) assert.equal(typeof row.description, 'string');
});
