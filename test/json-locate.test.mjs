import assert from 'node:assert/strict';
import test from 'node:test';
import { locateJsonPaths, lineOf } from '../lib/json-locate.mjs';

const SAMPLE = `{
  "model": "opus[1m]",
  "permissions": {
    "defaultMode": "auto",
    "allow": [
      "Bash(ls:*)",
      "Bash(git status)"
    ],
    "deny": []
  },
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-secret"
  }
}
`;

test('locates top-level keys on their own line', () => {
	const index = locateJsonPaths(SAMPLE);
	assert.equal(index.get('model'), 2);
	assert.equal(index.get('permissions'), 3);
	assert.equal(index.get('env'), 11);
});

test('locates nested object keys', () => {
	const index = locateJsonPaths(SAMPLE);
	assert.equal(index.get('permissions.defaultMode'), 4);
	assert.equal(index.get('permissions.allow'), 5);
	assert.equal(index.get('permissions.deny'), 9);
	assert.equal(index.get('env.ANTHROPIC_API_KEY'), 12);
});

test('locates array elements by index', () => {
	const index = locateJsonPaths(SAMPLE);
	assert.equal(index.get('permissions.allow[0]'), 6);
	assert.equal(index.get('permissions.allow[1]'), 7);
});

test('lineOf falls back to the nearest known ancestor', () => {
	const index = locateJsonPaths(SAMPLE);
	// exact hit
	assert.equal(lineOf(index, 'permissions.allow[1]'), 7);
	// unknown leaf resolves to its parent rather than guessing
	assert.equal(lineOf(index, 'permissions.allow[99]'), 5);
	// completely unknown path resolves to line 1, never null
	assert.equal(lineOf(index, 'nope.nothing'), 1);
});

test('a key whose string value contains braces or colons does not corrupt the path', () => {
	const tricky = String.raw`{
  "hooks": {
    "command": "bash -c \"echo {a: 1} | tail\"",
    "after": "tail"
  }
}
`;
	const index = locateJsonPaths(tricky);
	assert.equal(index.get('hooks.command'), 3);
	assert.equal(index.get('hooks.after'), 4);
});

test('escaped quotes inside keys and values are handled', () => {
	const tricky = String.raw`{
  "a\"b": 1,
  "c": "d\"e"
}
`;
	const index = locateJsonPaths(tricky);
	assert.equal(index.get('a"b'), 2);
	assert.equal(index.get('c'), 3);
});

test('arrays of objects produce indexed object paths', () => {
	const nested = `{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          { "type": "command", "command": "x.sh" }
        ]
      }
    ]
  }
}
`;
	const index = locateJsonPaths(nested);
	assert.equal(index.get('hooks.PostToolUse[0].matcher'), 5);
	assert.equal(index.get('hooks.PostToolUse[0].hooks[0].type'), 7);
	assert.equal(index.get('hooks.PostToolUse[0].hooks[0].command'), 7);
});

test('malformed JSON still yields the lines it managed to parse', () => {
	const broken = `{
  "good": 1,
  "bad": [1, 2
`;
	const index = locateJsonPaths(broken);
	assert.equal(index.get('good'), 2);
	assert.equal(index.get('bad'), 3);
});

test('empty input yields an empty index without throwing', () => {
	assert.equal(locateJsonPaths('').size, 0);
	assert.equal(locateJsonPaths(null).size, 0);
});
