import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanExecPolicy } from '../lib/codex/execpolicy-scan.mjs';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-rules-'));
}

function writeRules(rulesDir, filename, content) {
	fs.mkdirSync(rulesDir, { recursive: true });
	fs.writeFileSync(path.join(rulesDir, filename), content);
	return path.join(rulesDir, filename);
}

test('parses a plain single-line allow rule', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeRules(
		path.join(home, '.codex', 'rules'),
		'default.rules',
		'prefix_rule(pattern=["git", "status"], decision="allow")\n',
	);

	const { rules, files, error } = scanExecPolicy({ home, projectRoot });
	assert.equal(error, null);
	assert.equal(files.length, 1);
	assert.equal(files[0].layer, 'user');
	assert.equal(files[0].exists, true);
	assert.equal(rules.length, 1);
	assert.deepEqual(rules[0].pattern, ['git', 'status']);
	assert.equal(rules[0].decision, 'allow');
	assert.equal(rules[0].layer, 'user');
	assert.equal(rules[0].line, 1);
	assert.ok(rules[0].link.startsWith('vscode://file'));
	assert.equal(rules[0].note, null);
});

test('renders a union pattern element as "a|b"', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeRules(
		path.join(home, '.codex', 'rules'),
		'default.rules',
		'prefix_rule(pattern=["git", ["status", "diff"]], decision="allow", justification="Read-only Git inspection", match=[["git", "status"]], not_match=[["git", "push"]])\n',
	);

	const { rules } = scanExecPolicy({ home, projectRoot });
	assert.equal(rules.length, 1);
	assert.deepEqual(rules[0].pattern, ['git', 'status|diff']);
	assert.equal(rules[0].justification, 'Read-only Git inspection');
	assert.deepEqual(rules[0].match, [['git', 'status']]);
	assert.deepEqual(rules[0].notMatch, [['git', 'push']]);
});

test('parses a prefix_rule call that spans multiple physical lines', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const content = [
		'prefix_rule(',
		'    pattern=["npm", "install"],',
		'    decision="allow",',
		'    justification="Package install",',
		')',
		'',
	].join('\n');
	writeRules(path.join(home, '.codex', 'rules'), 'default.rules', content);

	const { rules } = scanExecPolicy({ home, projectRoot });
	assert.equal(rules.length, 1);
	assert.deepEqual(rules[0].pattern, ['npm', 'install']);
	assert.equal(rules[0].decision, 'allow');
	assert.equal(rules[0].line, 1); // reports the line the call STARTS on
});

test('a # comment (outside any string) is ignored, including a trailing one on a rule line', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const content = [
		'# this whole line is a comment',
		'prefix_rule(pattern=["ls"], decision="allow")  # trailing comment',
		'prefix_rule(pattern=["echo", "a#b"], decision="allow")',
	].join('\n');
	writeRules(path.join(home, '.codex', 'rules'), 'default.rules', content);

	const { rules } = scanExecPolicy({ home, projectRoot });
	assert.equal(rules.length, 2);
	assert.deepEqual(rules[0].pattern, ['ls']);
	// A '#' INSIDE a string literal must survive, not be treated as a comment start.
	assert.deepEqual(rules[1].pattern, ['echo', 'a#b']);
});

test('a garbage line becomes its own unparsed row instead of being dropped', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const content = ['prefix_rule(pattern=["ls"], decision="allow")', 'this is not valid syntax at all', ''].join('\n');
	writeRules(path.join(home, '.codex', 'rules'), 'default.rules', content);

	const { rules } = scanExecPolicy({ home, projectRoot });
	assert.equal(rules.length, 2);
	const garbage = rules.find((r) => r.note === 'unparsed');
	assert.ok(garbage);
	assert.equal(garbage.decision, 'unknown');
	assert.equal(garbage.line, 2);
	assert.equal(garbage.raw, 'this is not valid syntax at all');
	assert.deepEqual(garbage.pattern, []);
});

test('the raw field on an unparsed row is capped at 200 chars', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const longLine = `garbage ${'x'.repeat(300)}`;
	writeRules(path.join(home, '.codex', 'rules'), 'default.rules', `${longLine}\n`);

	const { rules } = scanExecPolicy({ home, projectRoot });
	assert.equal(rules.length, 1);
	assert.equal(rules[0].raw.length, 200);
	assert.equal(rules[0].raw, longLine.slice(0, 200));
});

test('reads both user and project rules directories with the right layer id', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeRules(path.join(home, '.codex', 'rules'), 'default.rules', 'prefix_rule(pattern=["ls"], decision="allow")\n');
	writeRules(
		path.join(projectRoot, '.codex', 'rules'),
		'project.rules',
		'prefix_rule(pattern=["npm", "test"], decision="prompt")\n',
	);

	const { rules, files } = scanExecPolicy({ home, projectRoot });
	assert.equal(rules.length, 2);
	assert.ok(rules.some((r) => r.layer === 'user'));
	assert.ok(rules.some((r) => r.layer === 'project'));
	assert.equal(files.length, 2);
});

test('a secret-shaped literal inside a rule is redacted', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeRules(
		path.join(home, '.codex', 'rules'),
		'default.rules',
		'prefix_rule(pattern=["curl", "-H", "Authorization: Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX"], decision="allow")\n',
	);

	const { rules } = scanExecPolicy({ home, projectRoot });
	const joined = rules[0].pattern.join(' ');
	assert.ok(!joined.includes('sk-ABCDEFGHIJKLMNOPQRSTUVWX'), 'the raw secret must not survive redaction');
});

test('missing rules directories yield no rules, no files, and no throw', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const { rules, files, error } = scanExecPolicy({ home, projectRoot });
	assert.deepEqual(rules, []);
	assert.deepEqual(files, []);
	assert.equal(error, null);
});

test('guarded reality check: the real default.rules parses to at least 100 allow rules', () => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex', 'rules', 'default.rules')) || !fs.existsSync(projectRoot)) {
		return;
	}

	const { rules, error } = scanExecPolicy({ home, projectRoot });
	assert.equal(error, null);
	const allow = rules.filter((r) => r.decision === 'allow');
	assert.ok(allow.length >= 100, `expected >= 100 allow rules, got ${allow.length}`);
	const unparsed = rules.filter((r) => r.note === 'unparsed');
	assert.equal(
		unparsed.length,
		0,
		`expected the real file to parse cleanly, found ${unparsed.length} unparsed line(s)`,
	);
});
