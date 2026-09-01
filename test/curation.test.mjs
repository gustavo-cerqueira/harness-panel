import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CURATION_RELATIVE_PATH, matchesBypass, readCuration } from '../lib/curation.mjs';

// Curation is workspace DATA, not tool code: the file lives in the repo being
// inventoried, and the panel ships only the mechanism that reads it.

function makeRoot(contents) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-curation-'));
	if (contents !== undefined) {
		const file = path.join(root, CURATION_RELATIVE_PATH);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
	}
	return root;
}

test('a workspace with no curation file reports absence, never an error', () => {
	const result = readCuration({ projectRoot: makeRoot() });
	assert.equal(result.exists, false);
	assert.equal(result.error, null);
	assert.deepEqual(result.bypasses, []);
	assert.deepEqual(result.clusters, { skills: {}, commands: {}, agents: {}, mcp: {} });
	assert.ok(result.path.endsWith(CURATION_RELATIVE_PATH));
});

test('reads curated bypasses and cluster overrides', () => {
	const root = makeRoot({
		bypasses: [
			{
				guard: 'require-spec-lock.sh',
				match: 'require-spec-lock',
				text: 'Bash writes go around it.',
				verified: '2026-08-14',
			},
			{ guard: 'pre-commit gate', text: 'core.hooksPath skips it.', verified: '2026-08-14', standalone: true },
		],
		clusters: { skills: { 'my-skill': 'execution' }, commands: { 'my-cmd': 'delivery' } },
	});
	const result = readCuration({ projectRoot: root });
	assert.equal(result.exists, true);
	assert.equal(result.error, null);
	assert.equal(result.bypasses.length, 2);
	assert.equal(result.bypasses[0].guard, 'require-spec-lock.sh');
	assert.equal(result.bypasses[1].standalone, true);
	assert.equal(result.clusters.skills['my-skill'], 'execution');
	assert.equal(result.clusters.commands['my-cmd'], 'delivery');
	assert.deepEqual(result.warnings, []);
});

test('an unknown cluster id is dropped with a warning, never silently kept', () => {
	const root = makeRoot({ clusters: { skills: { good: 'execution', bad: 'not-a-cluster' } } });
	const result = readCuration({ projectRoot: root });
	assert.equal(result.clusters.skills.good, 'execution');
	assert.equal('bad' in result.clusters.skills, false);
	assert.ok(result.warnings.some((warning) => /bad/.test(warning) && /not-a-cluster/.test(warning)));
});

test('match is literal text, so a regex-shaped pattern can never run as one', () => {
	// The pattern and the names it runs against both come from the inventoried
	// repository, so a real regex engine would let that repository hand the
	// reader catastrophic backtracking and hang the tab on page load.
	const pattern = ['^(a+)+', '$'].join('');
	const root = makeRoot({ bypasses: [{ guard: 'x', match: pattern, text: 'y', verified: 'z' }] });
	const result = readCuration({ projectRoot: root });
	assert.equal(result.bypasses.length, 1);
	assert.equal(result.bypasses[0].match, pattern);
	assert.equal(result.bypasses[0].standalone, false);
	const started = Date.now();
	assert.equal(matchesBypass(result.bypasses[0], 'a'.repeat(4000) + '!'), false);
	assert.ok(Date.now() - started < 500, 'literal matching cannot backtrack');
});

test('match is case-insensitive and matches anywhere in the name', () => {
	const root = makeRoot({ bypasses: [{ guard: 'g', match: 'Spec-Lock', text: 't', verified: 'v' }] });
	const [entry] = readCuration({ projectRoot: root }).bypasses;
	assert.equal(matchesBypass(entry, '/repo/.claude/hooks/require-spec-lock.sh'), true);
	assert.equal(matchesBypass(entry, 'something-else.sh'), false);
	assert.equal(matchesBypass(entry, null), false);
	assert.equal(matchesBypass({ match: null }, 'anything'), false);
});

test('ownerOnlyKeys are read as literal substrings, and junk is dropped loudly', () => {
	const root = makeRoot({ ownerOnlyKeys: ['ANTHROPIC_MODEL', '_AGENT_MODEL', '', 7] });
	const result = readCuration({ projectRoot: root });
	assert.deepEqual(result.ownerOnlyKeys, ['ANTHROPIC_MODEL', '_AGENT_MODEL']);
	assert.equal(result.warnings.length, 2);
});

test('a workspace that declares no owner-only keys marks none', () => {
	assert.deepEqual(readCuration({ projectRoot: makeRoot({}) }).ownerOnlyKeys, []);
	assert.deepEqual(readCuration({ projectRoot: makeRoot() }).ownerOnlyKeys, []);
});

test('a bypass missing guard or text is dropped with a warning', () => {
	const root = makeRoot({ bypasses: [{ guard: 'only-a-guard' }, { text: 'only text' }] });
	const result = readCuration({ projectRoot: root });
	assert.deepEqual(result.bypasses, []);
	assert.equal(result.warnings.length, 2);
});

test('malformed JSON is reported as an error, not thrown, and yields no curation', () => {
	const result = readCuration({ projectRoot: makeRoot('{ not json') });
	assert.equal(result.exists, true);
	assert.ok(result.error);
	assert.deepEqual(result.bypasses, []);
});

test('a root that is not a JSON object is reported, never coerced', () => {
	const result = readCuration({ projectRoot: makeRoot('[1,2,3]') });
	assert.ok(result.error);
	assert.match(result.error, /object/i);
});

test('the curated map applies to classification, and beats a family rule', async () => {
	const { classify } = await import('../lib/taxonomy.mjs');
	const overrides = { skills: { 'superpowers:brainstorming': 'memory', 'nobody-elses-skill': 'governance' } };
	assert.deepEqual(classify('skills', 'nobody-elses-skill', overrides), {
		cluster: 'governance',
		clusterSource: 'exact',
	});
	// An override beats the shipped exact map, which already beats families.
	assert.equal(classify('skills', 'superpowers:brainstorming', overrides).cluster, 'memory');
	// Without overrides the shipped map still answers.
	assert.equal(classify('skills', 'superpowers:brainstorming').cluster, 'specification');
});

test('the shipped taxonomy carries no workspace-private names', async () => {
	const source = fs.readFileSync(new URL('../lib/taxonomy.mjs', import.meta.url), 'utf8');
	for (const personal of ['ez_code-review', 'working-on-ezapps', 'ez_backend-dev', 'backend-nestjs-reviewer']) {
		assert.equal(source.includes(personal), false, `${personal} is workspace curation and must live in the local file`);
	}
});
