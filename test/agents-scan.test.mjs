import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentCollisions, scanAgents } from '../lib/agents-scan.mjs';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agents-'));
}

function writeAgent(dir, fileName, frontmatterLines, body = '\nBody.\n') {
	fs.mkdirSync(dir, { recursive: true });
	const content = ['---', ...frontmatterLines, '---', body].join('\n');
	const file = path.join(dir, fileName);
	fs.writeFileSync(file, content);
	return file;
}

test('discovers agent definitions across user, project and plugin layers', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgent(path.join(home, '.claude', 'agents'), 'helper.md', [
		'name: helper',
		'description: Helps with things.',
		'model: sonnet',
		'tools: Read, Grep, Glob',
	]);
	writeAgent(path.join(projectRoot, '.claude', 'agents'), 'reviewer.md', [
		'name: reviewer',
		'description: Reviews things.',
		'tools: Read, Grep',
	]);
	const pluginAgentsDir = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit', '1.0.0', 'agents');
	writeAgent(pluginAgentsDir, 'ranger.md', ['name: ranger', 'description: Ranges around.']);

	const agents = scanAgents({ home, projectRoot });
	const byName = Object.fromEntries(agents.map((a) => [a.name, a]));

	assert.equal(byName.helper.layer, 'user');
	assert.equal(byName.helper.plugin, null);
	assert.deepEqual(byName.helper.tools, ['Read', 'Grep', 'Glob']);
	assert.equal(byName.helper.model, 'sonnet');
	assert.equal(byName.helper.valid, true);
	assert.equal(byName.helper.error, null);
	assert.ok(byName.helper.bytes > 0);

	assert.equal(byName.reviewer.layer, 'project');
	assert.deepEqual(byName.reviewer.tools, ['Read', 'Grep']);

	assert.equal(byName.ranger.layer, 'plugin');
	assert.equal(byName.ranger.plugin, 'toolkit');
	assert.deepEqual(byName.ranger.tools, []);
	assert.equal(byName.ranger.model, null);
});

test('discovers agents nested in subdirectories', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgent(path.join(home, '.claude', 'agents', 'nested', 'deep'), 'buried.md', [
		'name: buried',
		'description: Found anyway.',
	]);
	const agents = scanAgents({ home, projectRoot });
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, 'buried');
});

test('parses tools given as a YAML list, not just a comma string', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgent(path.join(home, '.claude', 'agents'), 'lister.md', [
		'name: lister',
		'description: Uses list-style tools.',
		'tools:',
		'  - Read',
		'  - Edit',
		'  - Bash',
	]);
	const agents = scanAgents({ home, projectRoot });
	assert.deepEqual(agents[0].tools, ['Read', 'Edit', 'Bash']);
});

test('a name without a description is marked invalid, because such a file never loads', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgent(path.join(home, '.claude', 'agents'), 'broken.md', ['name: broken']);
	const agents = scanAgents({ home, projectRoot });
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, 'broken');
	assert.equal(agents[0].valid, false);
	assert.match(agents[0].invalidReason, /description/i);
});

test('a co-located doc file with no name frontmatter key is skipped, not reported as invalid', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgent(path.join(home, '.claude', 'agents'), 'README.md', ['description: Just a doc, not an agent.']);
	const agents = scanAgents({ home, projectRoot });
	assert.equal(agents.length, 0);
});

test('a plain markdown file with no frontmatter at all is skipped', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const dir = path.join(home, '.claude', 'agents');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'notes.md'), '# Just notes\n\nNo frontmatter here.\n');
	const agents = scanAgents({ home, projectRoot });
	assert.equal(agents.length, 0);
});

test('agentCollisions groups same-named agents within the same directory only', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const dir = path.join(home, '.claude', 'agents');
	writeAgent(dir, 'dup-a.md', ['name: duplicate', 'description: first copy.']);
	writeAgent(dir, 'dup-b.md', ['name: duplicate', 'description: second copy, same dir.']);
	writeAgent(path.join(projectRoot, '.claude', 'agents'), 'dup-c.md', [
		'name: duplicate',
		'description: different dir, no collision.',
	]);

	const agents = scanAgents({ home, projectRoot });
	const collisions = agentCollisions(agents);

	assert.equal(collisions.length, 1);
	assert.equal(collisions[0].name, 'duplicate');
	assert.equal(collisions[0].agents.length, 2);
	const dirs = new Set(collisions[0].agents.map((a) => path.dirname(a.path)));
	assert.equal(dirs.size, 1);
});

test('folds a multi-line description into one string', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgent(path.join(home, '.claude', 'agents'), 'multi.md', [
		'name: multi',
		'description: Line one',
		'  line two',
		'  line three.',
	]);
	const agents = scanAgents({ home, projectRoot });
	assert.equal(agents[0].description, 'Line one line two line three.');
});

test('an unreadable agent file surfaces the real error rather than being skipped', () => {
	if (process.getuid && process.getuid() === 0) return; // root ignores permission bits
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const file = writeAgent(path.join(home, '.claude', 'agents'), 'locked.md', ['name: locked', 'description: d.']);
	fs.chmodSync(file, 0o000);
	try {
		const agents = scanAgents({ home, projectRoot });
		const entry = agents.find((a) => a.path === file);
		assert.ok(entry, 'the file is still discovered even though it cannot be read');
		assert.equal(entry.valid, false);
		assert.ok(entry.error && entry.error.length > 0);
		assert.equal(entry.bytes, null);
	} finally {
		fs.chmodSync(file, 0o644);
	}
});

test('bytes reflects the real file size', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const file = writeAgent(path.join(home, '.claude', 'agents'), 'sized.md', ['name: sized', 'description: d.']);
	const expected = Buffer.byteLength(fs.readFileSync(file, 'utf8'), 'utf8');
	const agents = scanAgents({ home, projectRoot });
	assert.equal(agents[0].bytes, expected);
});

test('link points at the name key line via vscodeLink', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const file = writeAgent(path.join(home, '.claude', 'agents'), 'linked.md', ['name: linked', 'description: d.']);
	const agents = scanAgents({ home, projectRoot });
	assert.equal(agents[0].line, 2); // line 1 = '---', line 2 = 'name: linked'
	assert.equal(agents[0].link, `vscode://file${file}:2`);
});

test('a plugin agent is stamped with its cached version and whether that version is the live one', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit');
	for (const version of ['1.0.0', '2.0.0']) {
		writeAgent(path.join(parent, version, 'agents'), 'ranger.md', ['name: ranger', 'description: Ranges around.']);
	}
	// Claude Code touches `.in_use` on the version a session loaded.
	fs.mkdirSync(path.join(parent, '2.0.0', '.in_use'), { recursive: true });

	const agents = scanAgents({ home, projectRoot });
	const rangers = agents.filter((a) => a.name === 'ranger');
	// The scanner reports what is on disk — both copies exist and both are listed.
	assert.equal(rangers.length, 2);
	const byVersion = Object.fromEntries(rangers.map((a) => [a.pluginVersion, a]));
	assert.deepEqual(Object.keys(byVersion).sort(), ['1.0.0', '2.0.0']);
	assert.equal(byVersion['2.0.0'].activeVersion, true);
	assert.equal(byVersion['1.0.0'].activeVersion, false);
});

test('a user or project agent is not version-scoped and claims neither flag', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgent(path.join(home, '.claude', 'agents'), 'helper.md', ['name: helper', 'description: Helps.']);
	writeAgent(path.join(projectRoot, '.claude', 'agents'), 'reviewer.md', ['name: reviewer', 'description: Reviews.']);

	for (const agent of scanAgents({ home, projectRoot })) {
		assert.equal(agent.pluginVersion, null);
		assert.equal(agent.activeVersion, null, 'only a plugin row can be a stale-version copy');
	}
});

test('with no .in_use marker anywhere, exactly one cached version is still called active', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit');
	for (const version of ['0.1.0', '0.2.0', '0.3.0']) {
		writeAgent(path.join(parent, version, 'agents'), 'ranger.md', ['name: ranger', 'description: Ranges around.']);
	}
	const rangers = scanAgents({ home, projectRoot }).filter((a) => a.name === 'ranger');
	assert.equal(rangers.filter((a) => a.activeVersion === true).length, 1);
	assert.equal(rangers.find((a) => a.activeVersion === true).pluginVersion, '0.3.0');
});
