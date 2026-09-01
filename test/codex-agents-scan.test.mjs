import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentCollisions, scanCodexAgents } from '../lib/codex/agents-scan.mjs';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-agents-'));
}

function writeAgentToml(dir, fileName, text) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, fileName);
	fs.writeFileSync(file, text);
	return file;
}

test('discovers valid user and project agents with the name field as identity, not the filename', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgentToml(
		path.join(home, '.codex', 'agents'),
		'file-does-not-match-name.toml',
		[
			'name = "luna_medium"',
			'description = "Low-cost worker for mechanical tasks."',
			'model = "gpt-5.6-luna"',
			'model_reasoning_effort = "medium"',
			'developer_instructions = """',
			'Handle only the narrow task assigned.',
			'"""',
		].join('\n'),
	);
	writeAgentToml(
		path.join(projectRoot, '.codex', 'agents'),
		'reviewer.toml',
		[
			'name = "reviewer"',
			"description = 'Reviews things.'",
			"developer_instructions = '''",
			'Read-only review.',
			"'''",
		].join('\n'),
	);

	const agents = scanCodexAgents({ home, projectRoot });
	const byName = Object.fromEntries(agents.filter((a) => a.layer !== 'builtin').map((a) => [a.name, a]));

	assert.equal(byName.luna_medium.layer, 'user');
	assert.equal(byName.luna_medium.model, 'gpt-5.6-luna');
	assert.equal(byName.luna_medium.reasoningEffort, 'medium');
	assert.equal(byName.luna_medium.valid, true);
	assert.equal(byName.luna_medium.invalidReason, null);
	assert.deepEqual(byName.luna_medium.tools, []);
	assert.ok(byName.luna_medium.developerInstructionsChars > 0);
	// path is the real file path; the file's basename does NOT need to match `name`
	assert.equal(path.basename(byName.luna_medium.path), 'file-does-not-match-name.toml');
	assert.ok(byName.luna_medium.line >= 1);
	assert.ok(byName.luna_medium.link.startsWith('vscode://file'));

	assert.equal(byName.reviewer.layer, 'project');
	assert.equal(byName.reviewer.model, null);
	assert.equal(byName.reviewer.valid, true);
});

test('an agent file missing description or developer_instructions is kept and flagged invalid, never dropped', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgentToml(
		path.join(home, '.codex', 'agents'),
		'broken.toml',
		['name = "broken"', 'model = "gpt-5.6-luna"'].join('\n'),
	);

	const agents = scanCodexAgents({ home, projectRoot });
	const row = agents.find((a) => a.name === 'broken');
	assert.ok(row, 'an invalid agent must still be surfaced');
	assert.equal(row.valid, false);
	assert.match(row.invalidReason, /description/);
	assert.match(row.invalidReason, /developer_instructions/);
});

test('always emits the three built-in agents as layer builtin with no file to link to', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const agents = scanCodexAgents({ home, projectRoot });
	const builtins = agents.filter((a) => a.layer === 'builtin');
	assert.deepEqual(builtins.map((a) => a.name).sort(), ['default', 'explorer', 'worker']);
	for (const b of builtins) {
		assert.equal(b.path, null);
		assert.equal(b.line, null);
		assert.equal(b.link, null);
		assert.equal(b.valid, true);
		assert.match(b.description, /Codex CLI/);
		assert.equal(b.overriddenBy, null);
	}
});

test('a custom agent sharing a built-in name marks the built-in row overriddenBy', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const customPath = writeAgentToml(
		path.join(home, '.codex', 'agents'),
		'worker.toml',
		['name = "worker"', 'description = "Custom worker override."', "developer_instructions = '''body'''"].join('\n'),
	);

	const agents = scanCodexAgents({ home, projectRoot });
	const builtinWorker = agents.find((a) => a.layer === 'builtin' && a.name === 'worker');
	const customWorker = agents.find((a) => a.layer === 'user' && a.name === 'worker');
	assert.ok(customWorker, 'the custom worker.toml should be kept as its own row');
	assert.equal(customWorker.path, customPath);
	assert.ok(Array.isArray(builtinWorker.overriddenBy) && builtinWorker.overriddenBy.length === 1);
	assert.equal(builtinWorker.overriddenBy[0].layer, 'user');
});

test('a same-name user/project collision keeps both rows and is reported by agentCollisions, never silently resolved', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgentToml(
		path.join(home, '.codex', 'agents'),
		'dup.toml',
		['name = "dup"', 'description = "user copy"', "developer_instructions = '''u'''"].join('\n'),
	);
	writeAgentToml(
		path.join(projectRoot, '.codex', 'agents'),
		'dup.toml',
		['name = "dup"', 'description = "project copy"', "developer_instructions = '''p'''"].join('\n'),
	);

	const agents = scanCodexAgents({ home, projectRoot });
	const dupRows = agents.filter((a) => a.name === 'dup');
	assert.equal(dupRows.length, 2, 'both the user and project copy must be kept');
	assert.deepEqual(dupRows.map((a) => a.layer).sort(), ['project', 'user']);

	const collisions = agentCollisions(agents);
	assert.equal(collisions.length, 1);
	assert.equal(collisions[0].name, 'dup');
	assert.equal(collisions[0].agents.length, 2);
});

test('mcp_servers override keys and skills config ride along as Codex extras', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeAgentToml(
		path.join(home, '.codex', 'agents'),
		'withextras.toml',
		[
			'name = "withextras"',
			'description = "has extras"',
			"developer_instructions = '''body'''",
			'sandbox_mode = "workspace-write"',
			'',
			'[mcp_servers.basic-memory]',
			'enabled = true',
			'',
			'[mcp_servers.context7]',
			'enabled = false',
		].join('\n'),
	);

	const agents = scanCodexAgents({ home, projectRoot });
	const row = agents.find((a) => a.name === 'withextras');
	assert.equal(row.sandboxMode, 'workspace-write');
	assert.deepEqual(row.mcpServersOverride.sort(), ['basic-memory', 'context7']);
});

test('missing agents directories yield only the three built-ins, no throw', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const agents = scanCodexAgents({ home, projectRoot });
	assert.equal(agents.length, 3);
	assert.ok(agents.every((a) => a.layer === 'builtin'));
});

test('guarded reality check: the real ~/.codex agents match the known machine inventory', () => {
	const home = os.homedir();
	// Project root defaults to this panel's own checkout; override via
	// HARNESS_REALITY_REPO to point at a repo with its own project-layer agents.
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex', 'agents')) || !fs.existsSync(projectRoot)) {
		return;
	}

	const agents = scanCodexAgents({ home, projectRoot });
	const builtins = agents.filter((a) => a.layer === 'builtin');
	const user = agents.filter((a) => a.layer === 'user');
	const project = agents.filter((a) => a.layer === 'project');

	// builtins are a fixed constant the scanner ships with, independent of any
	// machine or repo -- a real invariant, unlike the counts below.
	assert.equal(builtins.length, 3);
	assert.ok(user.length >= 4, `expected >= 4 user agents, got ${user.length}`);
	assert.ok(
		user.some((a) => a.name === 'luna_medium'),
		'known user agent luna_medium should be present',
	);
	// Project-layer counts and names are a fact about whichever repo projectRoot
	// points at, not about the scanner -- only validity is asserted for those.
	for (const agent of [...user, ...project]) {
		assert.equal(agent.valid, true, `${agent.path} should be a valid agent definition on this machine`);
	}
});
