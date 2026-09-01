import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, readJsonFile, readSourceFile, vscodeLink } from '../lib/source-file.mjs';

// Test scaffolding writes to a temp dir only. The library under test never
// writes; that is asserted separately by the read-only grep in the validation
// suite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-source-'));

test('reads an existing file and reports real metadata', () => {
	const file = path.join(TMP, 'plain.md');
	fs.writeFileSync(file, '# Title\nbody\n');
	const result = readSourceFile(file);
	assert.equal(result.exists, true);
	assert.equal(result.readable, true);
	assert.equal(result.content, '# Title\nbody\n');
	assert.equal(result.size, 13);
	assert.equal(result.error, null);
	assert.equal(result.isSymlink, false);
	assert.ok(typeof result.mtimeMs === 'number' && result.mtimeMs > 0);
});

test('a missing file is reported as absent with its path, never invented', () => {
	const file = path.join(TMP, 'does-not-exist.json');
	const result = readSourceFile(file);
	assert.equal(result.exists, false);
	assert.equal(result.readable, false);
	assert.equal(result.content, null);
	assert.equal(result.path, file);
	assert.match(result.error, /ENOENT/);
});

test('a symlink is reported as a symlink with its target, not as a duplicate', () => {
	const target = path.join(TMP, 'real.md');
	const link = path.join(TMP, 'link.md');
	fs.writeFileSync(target, 'shared\n');
	fs.symlinkSync(target, link);
	const result = readSourceFile(link);
	assert.equal(result.isSymlink, true);
	// realpath is intentional: on macOS /tmp is itself a symlink to /private/tmp,
	// and a deep link must point at the file the editor will actually open.
	assert.equal(result.symlinkTarget, fs.realpathSync(target));
	assert.equal(result.content, 'shared\n');
});

test('valid JSON yields parsed data plus a usable line index', () => {
	const file = path.join(TMP, 'settings.json');
	fs.writeFileSync(file, '{\n  "model": "opus",\n  "permissions": {\n    "defaultMode": "auto"\n  }\n}\n');
	const result = readJsonFile(file);
	assert.equal(result.parseError, null);
	assert.equal(result.json.model, 'opus');
	assert.equal(result.lineIndex.get('permissions.defaultMode'), 4);
});

test('malformed JSON surfaces the real parser error and keeps the raw content', () => {
	const file = path.join(TMP, 'broken.json');
	fs.writeFileSync(file, '{\n  "a": 1,\n');
	const result = readJsonFile(file);
	assert.equal(result.json, null);
	assert.ok(result.parseError && result.parseError.length > 0);
	assert.equal(result.exists, true);
	assert.equal(result.content, '{\n  "a": 1,\n');
	// still locates what it could, so the jump-to-source link works
	assert.equal(result.lineIndex.get('a'), 2);
});

test('a missing JSON file is absent, not an empty object', () => {
	const result = readJsonFile(path.join(TMP, 'nope.json'));
	assert.equal(result.exists, false);
	assert.equal(result.json, null);
	assert.equal(result.lineIndex.size, 0);
});

test('vscodeLink builds an absolute deep link with a line anchor', () => {
	assert.equal(vscodeLink('/a/b/c.json', 12), 'vscode://file/a/b/c.json:12');
	assert.equal(vscodeLink('/a/b/c.json'), 'vscode://file/a/b/c.json:1');
});

test('vscodeLink refuses relative paths rather than emitting a broken link', () => {
	assert.equal(vscodeLink('relative/path.json', 3), null);
	assert.equal(vscodeLink(null, 3), null);
});

test('estimateTokens approximates four characters per token', () => {
	assert.equal(estimateTokens('abcd'), 1);
	assert.equal(estimateTokens('a'.repeat(400)), 100);
	assert.equal(estimateTokens(''), 0);
	assert.equal(estimateTokens(null), 0);
});
