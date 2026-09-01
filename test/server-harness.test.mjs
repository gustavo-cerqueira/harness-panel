/**
 * The harness dimension, end to end over HTTP.
 *
 * The panel now inventories TWO harnesses from one server: Claude Code and
 * Codex CLI. This test boots the real server on an ephemeral port against a
 * throwaway home + repo and asserts the contract every other piece depends on:
 * which harness a request lands on, which sections that harness has, and what
 * happens when the caller asks for one that does not exist.
 *
 * It deliberately does NOT assert that any Codex scanner works — those modules
 * land in later commits. A section whose module is missing must degrade to an
 * honest error row, and that degradation is exactly what is asserted here: the
 * panel stays up and reports the real reason instead of inventing data.
 *
 * The server never writes; the FIXTURE does, under os.tmpdir(), which is the
 * test's own scratch space and not a config surface.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPanelServer, harnessIds, sectionIds } from '../server.mjs';

const CLAUDE_IDS = [
	'memory',
	'settings',
	'hooks',
	'skills',
	'commands',
	'agents',
	'mcp',
	'directives',
	'rules',
	'plugins',
	'worktrees',
	'injected',
];

const CODEX_IDS = [
	'memory',
	'settings',
	'hooks',
	'skills',
	'commands',
	'agents',
	'mcp',
	'directives',
	'rules',
	'execpolicy',
	'plugins',
	'worktrees',
	'injected',
];

let panel = null;
let base = '';
let fixture = '';

/** A throwaway home + repo. Empty on purpose: the scanners must survive it. */
function makeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-server-'));
	const home = path.join(dir, 'home');
	const repo = path.join(dir, 'repo');
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
	fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
	fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# user memory\n');
	fs.writeFileSync(path.join(repo, '.claude', 'CLAUDE.md'), '# project memory\n');
	fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.6-terra"\n');
	fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# agents\n');
	return { dir, home, repo };
}

const get = async (urlPath) => {
	const response = await fetch(`${base}${urlPath}`);
	return { status: response.status, body: await response.json() };
};

before(async () => {
	const made = makeFixture();
	fixture = made.dir;
	// `.listen()` on the returned API exits the process on EADDRINUSE, which
	// would kill the test runner. The raw server is what a test wants.
	panel = createPanelServer({ home: made.home, projectRoot: made.repo });
	await new Promise((resolve) => panel.server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${panel.server.address().port}`;
});

after(async () => {
	if (panel) await new Promise((resolve) => panel.server.close(resolve));
	if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

test('harnessIds() lists both harnesses, claude first', () => {
	assert.deepEqual(harnessIds(), ['claude', 'codex']);
});

test('sectionIds() defaults to the Claude registry and accepts a harness id', () => {
	assert.deepEqual(sectionIds(), CLAUDE_IDS);
	assert.deepEqual(sectionIds('claude'), CLAUDE_IDS);
	assert.deepEqual(sectionIds('codex'), CODEX_IDS);
	assert.deepEqual(sectionIds('nope'), [], 'an unknown harness has no sections, and must not throw');
});

test('no ?harness= means Claude Code, with the 12 Claude sections', async () => {
	const { status, body } = await get('/api/state');
	assert.equal(status, 200);
	assert.equal(body.meta.harness.id, 'claude');
	assert.equal(body.meta.harness.label, 'Claude Code');
	assert.deepEqual(
		body.meta.harness.available.map((entry) => entry.id),
		['claude', 'codex'],
	);
	assert.deepEqual(
		body.meta.sectionOrder.map((section) => section.id),
		CLAUDE_IDS,
	);
	assert.deepEqual(Object.keys(body.sections), CLAUDE_IDS);
	assert.match(body.meta.baseSystemPrompt, /internal to Claude Code/);
});

test('?harness=codex switches the whole state to the Codex registry', async () => {
	const { status, body } = await get('/api/state?harness=codex');
	assert.equal(status, 200);
	assert.equal(body.meta.harness.id, 'codex');
	assert.equal(body.meta.harness.label, 'Codex CLI');
	assert.deepEqual(
		body.meta.sectionOrder.map((section) => section.id),
		CODEX_IDS,
	);
	assert.deepEqual(Object.keys(body.sections), CODEX_IDS);
	assert.match(body.meta.baseSystemPrompt, /AGENTS\.md chain/);
});

test('a Codex section is either read or honestly reported as unreadable', async () => {
	const { body } = await get('/api/state?harness=codex');
	for (const id of CODEX_IDS) {
		const section = body.sections[id];
		assert.ok(section, `section ${id} is missing from the state`);
		if (section.ok === true) {
			assert.notEqual(section.data, undefined, `section ${id} reports ok with no data`);
			continue;
		}
		assert.equal(section.ok, false, `section ${id} must be ok:true or ok:false`);
		assert.equal(typeof section.error, 'string', `section ${id} must carry a real error string`);
		assert.ok(section.error.length > 0, `section ${id} error must not be empty`);
		assert.match(section.modulePath, /lib\/codex\//, `section ${id} must name the module it tried`);
	}
});

test('the Claude and Codex states are cached apart, not overwritten', async () => {
	const claude = await get('/api/state');
	const codex = await get('/api/state?harness=codex');
	const claudeAgain = await get('/api/state');
	assert.equal(claude.body.meta.harness.id, 'claude');
	assert.equal(codex.body.meta.harness.id, 'codex');
	assert.equal(claudeAgain.body.meta.harness.id, 'claude');
	assert.deepEqual(
		claudeAgain.body.meta.sectionOrder.map((section) => section.id),
		CLAUDE_IDS,
	);
});

test('an unknown harness is refused with 400 and the list of real ones', async () => {
	const { status, body } = await get('/api/state?harness=nope');
	assert.equal(status, 400);
	assert.equal(body.error, 'unknown harness');
	assert.equal(body.requested, 'nope');
	assert.deepEqual(body.known, ['claude', 'codex']);
});

test('/api/section validates the id against the requested harness', async () => {
	const claude = await get('/api/section/execpolicy?harness=claude');
	assert.equal(claude.status, 404, 'exec policy is a Codex-only section');
	assert.equal(claude.body.error, 'unknown section');
	assert.deepEqual(claude.body.known, CLAUDE_IDS);

	const codex = await get('/api/section/execpolicy?harness=codex');
	assert.equal(codex.status, 200);
	assert.ok(codex.body.ok === true || typeof codex.body.error === 'string');

	const missing = await get('/api/section/nothing?harness=codex');
	assert.equal(missing.status, 404);
	assert.deepEqual(missing.body.known, CODEX_IDS);
});

test('/api/section, /api/file and /api/hook-script all refuse an unknown harness', async () => {
	for (const url of [
		'/api/section/memory?harness=nope',
		'/api/file?harness=nope&path=/etc/hosts',
		'/api/hook-script?harness=nope&path=/etc/hosts',
	]) {
		const { status, body } = await get(url);
		assert.equal(status, 400, `${url} must be refused`);
		assert.equal(body.error, 'unknown harness');
		assert.deepEqual(body.known, ['claude', 'codex']);
	}
});

test('the read-only gate still answers every mutating verb with 405', async () => {
	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
		const response = await fetch(`${base}/api/state?harness=codex`, { method });
		assert.equal(response.status, 405, `${method} must not be served`);
		assert.equal(response.headers.get('allow'), 'GET, HEAD');
	}
});

test('the served page carries the harness selector', async () => {
	const response = await fetch(`${base}/`);
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.match(html, /id="harness"/);
	assert.match(html, /value="codex"/);
});
