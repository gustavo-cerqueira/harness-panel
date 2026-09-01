import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseToml, lineOfTomlKey, flattenToml } from '../lib/codex/toml.mjs';

test('empty and non-string input yields empty results without throwing', () => {
	const empty = parseToml('');
	assert.equal(empty.value && typeof empty.value === 'object', true);
	assert.deepEqual(empty.value, {});
	assert.equal(empty.locations.size, 0);
	assert.equal(empty.errors.length, 0);

	const nullish = parseToml(null);
	assert.deepEqual(nullish.value, {});
	assert.equal(nullish.locations.size, 0);
	assert.equal(nullish.errors.length, 0);
});

test('locates a top-level key on its own line', () => {
	const text = ['model = "gpt-5.6-sol"', 'name = "demo"'].join('\n');
	const { value, locations, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.model, 'gpt-5.6-sol');
	assert.equal(value.name, 'demo');
	assert.deepEqual(locations.get(JSON.stringify(['model'])), { line: 1, column: 1 });
	assert.deepEqual(locations.get(JSON.stringify(['name'])), { line: 2, column: 1 });
	assert.equal(lineOfTomlKey(locations, ['model']), 1);
	assert.equal(lineOfTomlKey(locations, ['name']), 2);
});

test('locates a key inside a quoted table-header path segment as ONE segment', () => {
	const text = ['[projects."/Users/example/projects/demo-app"]', 'trust_level = "trusted"'].join('\n');
	const { value, locations, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.projects['/Users/example/projects/demo-app'].trust_level, 'trusted');
	assert.equal(lineOfTomlKey(locations, ['projects', '/Users/example/projects/demo-app']), 1);
	assert.equal(lineOfTomlKey(locations, ['projects', '/Users/example/projects/demo-app', 'trust_level']), 2);
});

test('locates a key inside a dotted nested table header like [mcp_servers.x.env]', () => {
	const text = [
		'[mcp_servers.node_repl]',
		'command = "run"',
		'',
		'[mcp_servers.node_repl.env]',
		'FOO = "bar"',
		'BAZ = "qux"',
	].join('\n');
	const { value, locations, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.deepEqual(value.mcp_servers.node_repl.env, { FOO: 'bar', BAZ: 'qux' });
	assert.equal(lineOfTomlKey(locations, ['mcp_servers', 'node_repl', 'command']), 2);
	assert.equal(lineOfTomlKey(locations, ['mcp_servers', 'node_repl', 'env']), 4);
	assert.equal(lineOfTomlKey(locations, ['mcp_servers', 'node_repl', 'env', 'FOO']), 5);
	assert.equal(lineOfTomlKey(locations, ['mcp_servers', 'node_repl', 'env', 'BAZ']), 6);
});

test('locates a key inside a [[array-of-tables]] entry, including the row header itself', () => {
	const text = [
		'[[servers]]',
		'name = "primary"',
		'port = 8080',
		'',
		'[[servers]]',
		'name = "secondary"',
		'port = 8081',
	].join('\n');
	const { value, locations, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.deepEqual(value.servers, [
		{ name: 'primary', port: 8080 },
		{ name: 'secondary', port: 8081 },
	]);
	assert.equal(lineOfTomlKey(locations, ['servers', '0']), 1);
	assert.equal(lineOfTomlKey(locations, ['servers', '0', 'name']), 2);
	assert.equal(lineOfTomlKey(locations, ['servers', '0', 'port']), 3);
	assert.equal(lineOfTomlKey(locations, ['servers', '1']), 5);
	assert.equal(lineOfTomlKey(locations, ['servers', '1', 'name']), 6);
});

test('a multi-line basic string key locates to the line the KEY starts on, not where the string closes', () => {
	const text = ['description = """', 'line one', 'line two"""', 'next_key = "after"'].join('\n');
	const { value, locations, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.description, 'line one\nline two');
	assert.equal(lineOfTomlKey(locations, ['description']), 1);
	assert.equal(lineOfTomlKey(locations, ['next_key']), 4);
});

test('a multi-line array key locates to the line the KEY starts on, not where the array closes', () => {
	const text = ['values = [', '  1,', '  2,', '  3,', ']', 'after_key = "z"'].join('\n');
	const { value, locations, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.deepEqual(value.values, [1, 2, 3]);
	assert.equal(lineOfTomlKey(locations, ['values']), 1);
	assert.equal(lineOfTomlKey(locations, ['after_key']), 6);
});

test('malformed line records one error at the right line; later keys still parse', () => {
	const text = ['good = 1', '!!!not a valid key!!!', 'after = 2'].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(value.good, 1);
	assert.equal(value.after, 2);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].line, 2);
	assert.equal(typeof errors[0].message, 'string');
});

test('duplicate key definitions record an error and keep the first value', () => {
	const text = ['a = 1', 'a = 2'].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(value.a, 1);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].line, 2);
});

test('comments are ignored, including trailing comments after a value', () => {
	const text = ['# leading comment', 'a = 1 # trailing comment', '# another comment', 'b = 2'].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.a, 1);
	assert.equal(value.b, 2);
});

test('bare and quoted keys, dotted keys build nested objects', () => {
	const text = ["'lit-key' = 1", 'a.b.c = 2', '"a b" = 3'].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value['lit-key'], 1);
	assert.equal(value.a.b.c, 2);
	assert.equal(value['a b'], 3);
});

test('booleans, integer bases, and float forms', () => {
	const text = [
		'flag_true = true',
		'flag_false = false',
		'dec = 1_000',
		'hex = 0xFF',
		'oct = 0o17',
		'bin = 0b1010',
		'flt = -1.5e10',
		'infinite = inf',
		'neg_infinite = -inf',
		'not_a_number = nan',
	].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.flag_true, true);
	assert.equal(value.flag_false, false);
	assert.equal(value.dec, 1000);
	assert.equal(value.hex, 255);
	assert.equal(value.oct, 15);
	assert.equal(value.bin, 10);
	assert.equal(value.flt, -1.5e10);
	assert.equal(value.infinite, Infinity);
	assert.equal(value.neg_infinite, -Infinity);
	assert.equal(Number.isNaN(value.not_a_number), true);
});

test('RFC3339 datetime, local date, and local time are kept as their source string', () => {
	const text = ['created_at = 2026-08-18T23:04:06Z', 'due_date = 2026-08-18', 'wake_time = 07:32:00'].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.created_at, '2026-08-18T23:04:06Z');
	assert.equal(value.due_date, '2026-08-18');
	assert.equal(value.wake_time, '07:32:00');
});

test('basic string escapes: \\n \\t \\" \\\\ and \\uXXXX', () => {
	const text = String.raw`greeting = "line1\nline2\ttabbed \"quoted\" back\\slash \u0041"`;
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.greeting, 'line1\nline2\ttabbed "quoted" back\\slash A');
});

test('literal strings do not process escapes', () => {
	const text = String.raw`path = 'C:\Users\example\no\escapes'`;
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.path, 'C:\\Users\\example\\no\\escapes');
});

test('multi-line literal string trims only the first newline', () => {
	const text = ["block = '''", "raw \\n stays raw'''"].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.block, 'raw \\n stays raw');
});

test('multi-line basic string trims a line-ending backslash and following whitespace', () => {
	const text = ['msg = """', 'one line \\', '    continued"""'].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(value.msg, 'one line continued');
});

test('inline tables (single line)', () => {
	const text = 'point = { x = 1, y = "two" }';
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.deepEqual(value.point, { x: 1, y: 'two' });
});

test('arrays: multi-line, trailing comma, comments between elements, nested', () => {
	const text = ['nums = [', '  1, # one', '  2, # two', '  [3, 4],', '  5,', ']'].join('\n');
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.deepEqual(value.nums, [1, 2, [3, 4], 5]);
});

test('a quoted table-header segment containing colons, like hooks.state entries', () => {
	const text = [
		'[hooks.state]',
		'',
		'[hooks.state."/Users/example/.codex/hooks.json:session_start:0:0"]',
		'trusted_hash = "sha256:deadbeef"',
	].join('\n');
	const { value, locations, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.deepEqual(Object.keys(value.hooks.state), ['/Users/example/.codex/hooks.json:session_start:0:0']);
	assert.equal(value.hooks.state['/Users/example/.codex/hooks.json:session_start:0:0'].trusted_hash, 'sha256:deadbeef');
	assert.equal(lineOfTomlKey(locations, ['hooks', 'state']), 1);
	assert.equal(lineOfTomlKey(locations, ['hooks', 'state', '/Users/example/.codex/hooks.json:session_start:0:0']), 3);
});

test('lineOfTomlKey returns null for an unknown path and for bad inputs, never throws', () => {
	const { locations } = parseToml('a = 1');
	assert.equal(lineOfTomlKey(locations, ['a']), 1);
	assert.equal(lineOfTomlKey(locations, ['nope']), null);
	assert.equal(lineOfTomlKey(null, ['a']), null);
	assert.equal(lineOfTomlKey(locations, null), null);
});

test('flattenToml emits one leaf per scalar and quotes segments with ".", "/", space, or a quote', () => {
	const { value } = parseToml(
		['[projects."/abs/path"]', 'trust_level = "trusted"', '', '[projects."/abs/path".nested]', 'x = 1'].join('\n'),
	);
	const leaves = flattenToml(value);
	const byKey = new Map(leaves.map((l) => [l.key, l]));
	assert.equal(byKey.get('projects."/abs/path".trust_level').value, 'trusted');
	assert.deepEqual(byKey.get('projects."/abs/path".trust_level').path, ['projects', '/abs/path', 'trust_level']);
	assert.equal(byKey.get('projects."/abs/path".nested.x').value, 1);
});

test('flattenToml treats an array of scalars as a single leaf', () => {
	const { value } = parseToml('allow = ["Bash(ls:*)", "Bash(git status)"]');
	const leaves = flattenToml(value);
	assert.equal(leaves.length, 1);
	assert.equal(leaves[0].key, 'allow');
	assert.deepEqual(leaves[0].value, ['Bash(ls:*)', 'Bash(git status)']);
});

test('flattenToml recurses into an array of tables with numeric index segments', () => {
	const { value } = parseToml(['[[servers]]', 'name = "primary"', '', '[[servers]]', 'name = "secondary"'].join('\n'));
	const leaves = flattenToml(value);
	const byKey = new Map(leaves.map((l) => [l.key, l]));
	assert.equal(byKey.get('servers.0.name').value, 'primary');
	assert.deepEqual(byKey.get('servers.0.name').path, ['servers', '0', 'name']);
	assert.equal(byKey.get('servers.1.name').value, 'secondary');
});

test('parses the real ~/.codex/config.toml with zero errors, when present on this machine', async (t) => {
	const realPath = path.join(os.homedir(), '.codex', 'config.toml');
	if (!fs.existsSync(realPath)) {
		t.skip('no real ~/.codex/config.toml on this machine');
		return;
	}
	const text = fs.readFileSync(realPath, 'utf8');
	const { value, errors } = parseToml(text);
	assert.equal(errors.length, 0);
	assert.equal(typeof value.model, 'string');
	const stateKeys = Object.keys(value.hooks?.state ?? {});
	assert.equal(
		stateKeys.some((key) => key.includes(':session_start:')),
		true,
	);
});
