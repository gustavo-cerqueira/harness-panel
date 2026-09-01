import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexSkills, codexSkillListingTotals } from '../lib/codex/skills-scan.mjs';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-skills-'));
}

function writeSkill(skillsDir, name, frontmatterLines, body = '\nBody text.\n') {
	const dir = path.join(skillsDir, name);
	fs.mkdirSync(dir, { recursive: true });
	const content = ['---', ...frontmatterLines, '---', body].join('\n');
	fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
	return dir;
}

function writeConfigToml(codexHome, text) {
	fs.mkdirSync(codexHome, { recursive: true });
	fs.writeFileSync(path.join(codexHome, 'config.toml'), text);
}

test('discovers skills across every root with the right layer id', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();

	writeSkill(path.join(home, '.codex', 'skills'), 'legacy-skill', [
		'name: legacy-skill',
		'description: deprecated root.',
	]);
	writeSkill(path.join(home, '.codex', 'skills', '.system'), 'imagegen', [
		'name: imagegen',
		'description: bundled with the CLI.',
	]);
	writeSkill(path.join(home, '.agents', 'skills'), 'user-skill', [
		'name: user-skill',
		'description: preferred user root.',
	]);
	writeSkill(path.join(projectRoot, '.agents', 'skills'), 'team-skill', [
		'name: team-skill',
		'description: repo team root.',
	]);
	writeSkill(path.join(projectRoot, '.codex', 'skills'), 'project-skill', [
		'name: project-skill',
		'description: adjacent to project config.',
	]);
	writeSkill(path.join(home, '.codex', 'plugins', 'cache', 'acme', 'toolkit', '1.0.0', 'skills'), 'gamma', [
		'name: gamma',
		'description: plugin-contributed.',
	]);

	const result = scanCodexSkills({ home, projectRoot });
	const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]));

	assert.equal(byName['legacy-skill'].layer, 'user');
	assert.equal(byName['imagegen'].layer, 'system');
	assert.equal(byName['user-skill'].layer, 'user');
	assert.equal(byName['team-skill'].layer, 'project');
	assert.equal(byName['project-skill'].layer, 'project');
	assert.equal(byName['gamma'].layer, 'plugin');
	assert.equal(byName['gamma'].qualifiedName, 'toolkit:gamma');
	assert.equal(byName['gamma'].plugin, 'toolkit');
	assert.equal(result.skills.length, 6);

	// Row-shape parity with the Claude counterpart.
	const legacy = byName['legacy-skill'];
	assert.equal(legacy.state, 'on');
	assert.equal(legacy.stateSource, null);
	assert.equal(legacy.shadowedBy, null);
	assert.equal(legacy.usageKnown, false);
	assert.equal(legacy.usageCount, null);
	assert.equal(legacy.lastUsedAt, null);
	assert.equal(legacy.listingChars, 'legacy-skill'.length + 'deprecated root.'.length + 8);
	assert.ok(legacy.link.startsWith('vscode://file'));
	assert.equal(legacy.isSymlink, false);
	assert.equal(legacy.symlinkTarget, null);
});

test('follows a symlinked skill directory and reports it', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();

	const realDir = path.join(home, 'shared-skill-src');
	fs.mkdirSync(realDir, { recursive: true });
	fs.writeFileSync(
		path.join(realDir, 'SKILL.md'),
		['---', 'name: linked-skill', 'description: lives elsewhere.', '---', 'Body.'].join('\n'),
	);

	const skillsDir = path.join(home, '.agents', 'skills');
	fs.mkdirSync(skillsDir, { recursive: true });
	fs.symlinkSync(realDir, path.join(skillsDir, 'linked-skill'));

	const result = scanCodexSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'linked-skill');
	assert.ok(skill, 'symlinked skill directory should be discovered');
	assert.equal(skill.isSymlink, true);
	assert.equal(skill.symlinkTarget, fs.realpathSync(realDir));
	assert.equal(skill.description, 'lives elsewhere.');
});

test('a name collision across roots is reported as a duplicate, never collapsed', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();

	writeSkill(path.join(projectRoot, '.agents', 'skills'), 'openspec-apply', [
		'name: openspec-apply',
		'description: from .agents.',
	]);
	writeSkill(path.join(projectRoot, '.codex', 'skills'), 'openspec-apply', [
		'name: openspec-apply',
		'description: from .codex, different text.',
	]);

	const result = scanCodexSkills({ home, projectRoot });
	const copies = result.skills.filter((s) => s.name === 'openspec-apply');
	assert.equal(copies.length, 2);
	for (const copy of copies) assert.equal(copy.shadowedBy, null);

	assert.equal(result.duplicates.length, 1);
	const dup = result.duplicates[0];
	assert.equal(dup.name, 'openspec-apply');
	assert.deepEqual(dup.layers, ['project']);
	assert.equal(dup.paths.length, 2);
	assert.equal(dup.identical, false);
});

test('a [[skills.config]] entry with enabled = false turns a skill off with its source line', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();

	const skillDir = writeSkill(path.join(home, '.agents', 'skills'), 'off-skill', [
		'name: off-skill',
		'description: should be disabled.',
	]);
	const skillPath = path.join(skillDir, 'SKILL.md');

	writeConfigToml(
		path.join(home, '.codex'),
		[
			'model = "gpt-5"',
			'',
			'[[skills.config]]',
			`path = "${skillPath}"`,
			'enabled = false',
			'',
			'[[skills.config]]',
			'path = "/some/other/SKILL.md"',
			'enabled = true',
		].join('\n'),
	);

	const result = scanCodexSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'off-skill');
	assert.equal(skill.state, 'off');
	assert.equal(skill.stateSource, path.join(home, '.codex', 'config.toml'));
	assert.equal(skill.stateLine, 4);
	assert.equal(skill.stateLink, `vscode://file${skill.stateSource}:4`);
});

test('duplicate skills stay on even when disabled elsewhere -- state is per-path, not per-name', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const dirA = writeSkill(path.join(home, '.agents', 'skills'), 'same-name', [
		'name: same-name',
		'description: copy A.',
	]);
	writeSkill(path.join(projectRoot, '.codex', 'skills'), 'same-name', ['name: same-name', 'description: copy B.']);

	writeConfigToml(
		path.join(home, '.codex'),
		['[[skills.config]]', `path = "${path.join(dirA, 'SKILL.md')}"`, 'enabled = false'].join('\n'),
	);

	const result = scanCodexSkills({ home, projectRoot });
	const copies = result.skills.filter((s) => s.name === 'same-name');
	const off = copies.find((s) => s.description === 'copy A.');
	const on = copies.find((s) => s.description === 'copy B.');
	assert.equal(off.state, 'off');
	assert.equal(on.state, 'on');
});

test('codexSkillListingTotals excludes off skills but never excludes on duplicates', () => {
	const skills = [
		{ state: 'on', layer: 'user', listingChars: 10, estimatedTokens: 3 },
		{ state: 'on', layer: 'project', listingChars: 20, estimatedTokens: 5 },
		{ state: 'off', layer: 'project', listingChars: 999, estimatedTokens: 250 },
	];
	const totals = codexSkillListingTotals(skills);
	assert.equal(totals.totalChars, 30);
	assert.equal(totals.estimatedTokens, 8);
	assert.equal(totals.countByLayer.user, 1);
	assert.equal(totals.countByLayer.project, 1);
	assert.equal(totals.countByState.off, 1);
	assert.equal(totals.countByState.on, 2);
});

test('an unreadable SKILL.md is reported with its error, not thrown', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const dir = path.join(home, '.agents', 'skills', 'broken');
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(path.join(dir, 'SKILL.md')); // a directory named SKILL.md, not a file

	const result = scanCodexSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'broken');
	assert.ok(skill);
	assert.ok(skill.error, 'a directory standing in for SKILL.md should surface as an error');
});

test('an empty tree returns no skills and no duplicates, never throws', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const result = scanCodexSkills({ home, projectRoot });
	assert.deepEqual(result.skills, []);
	assert.deepEqual(result.duplicates, []);
	assert.deepEqual(result.orphanOverrides, []);
	assert.equal(result.disableBundledSkills, null);
	assert.equal(result.usage.available, false);
});

test('guarded reality check: real ~/.codex and project root, non-throwing with plausible counts', () => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	if (!fs.existsSync(path.join(home, '.codex')) || !fs.existsSync(projectRoot)) {
		return; // this machine does not have the real Codex tree -- skip rather than fail
	}

	const result = scanCodexSkills({ home, projectRoot });
	assert.ok(Array.isArray(result.skills));
	const systemSkills = result.skills.filter((s) => s.layer === 'system');
	assert.ok(systemSkills.length >= 6, `expected >= 6 system skills, got ${systemSkills.length}`);
	for (const skill of result.skills) {
		assert.equal(typeof skill.name, 'string');
		assert.ok(skill.path === null || path.isAbsolute(skill.path));
	}
});
