import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSkills, skillListingTotals } from '../lib/skills-scan.mjs';

// Each test gets its own fake `home` and `projectRoot` so settings-cascade
// state from one scenario never bleeds into another.
function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-skills-'));
}

function writeSkill(skillsDir, name, frontmatterLines, body = '\nBody text.\n') {
	const dir = path.join(skillsDir, name);
	fs.mkdirSync(dir, { recursive: true });
	const content = ['---', ...frontmatterLines, '---', body].join('\n');
	const file = path.join(dir, 'SKILL.md');
	fs.writeFileSync(file, content);
	return file;
}

function writeSettings(dotClaudeDir, json) {
	fs.mkdirSync(dotClaudeDir, { recursive: true });
	fs.writeFileSync(path.join(dotClaudeDir, 'settings.json'), JSON.stringify(json, null, 2));
}

function writeLocalSettings(projectRoot, json) {
	const dir = path.join(projectRoot, '.claude');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify(json, null, 2));
}

test('discovers skills across user, project and plugin layers', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'alpha', ['name: alpha', 'description: Does alpha things.']);
	writeSkill(path.join(projectRoot, '.claude', 'skills'), 'beta', ['name: beta', 'description: Does beta things.']);
	const pluginSkillsDir = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit', '1.0.0', 'skills');
	writeSkill(pluginSkillsDir, 'gamma', ['name: gamma', 'description: Does gamma things.']);

	const result = scanSkills({ home, projectRoot });
	const byQualified = Object.fromEntries(result.skills.map((s) => [s.qualifiedName, s]));

	assert.equal(byQualified.alpha.layer, 'user');
	assert.equal(byQualified.alpha.plugin, null);
	assert.equal(byQualified.beta.layer, 'project');
	assert.equal(byQualified['toolkit:gamma'].layer, 'plugin');
	assert.equal(byQualified['toolkit:gamma'].plugin, 'toolkit');
	assert.equal(byQualified['toolkit:gamma'].name, 'gamma');
	assert.equal(byQualified.alpha.description, 'Does alpha things.');
	assert.equal(byQualified.alpha.listingChars, 'alpha'.length + 'Does alpha things.'.length + 8);
	assert.ok(byQualified.alpha.link.startsWith('vscode://file'));
	assert.equal(byQualified.alpha.state, 'on');
	assert.equal(byQualified.alpha.stateSource, null);
	assert.equal(byQualified.alpha.error, null);
});

test('resolves all four skillOverrides values with source path and line', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'on-skill', ['name: on-skill', 'description: stays on.']);
	writeSkill(path.join(home, '.claude', 'skills'), 'name-only-skill', [
		'name: name-only-skill',
		'description: hidden desc.',
	]);
	writeSkill(path.join(home, '.claude', 'skills'), 'invocable-skill', [
		'name: invocable-skill',
		'description: model hidden.',
	]);
	writeSkill(path.join(home, '.claude', 'skills'), 'off-skill', ['name: off-skill', 'description: fully hidden.']);

	const settingsPath = path.join(home, '.claude', 'settings.json');
	writeSettings(path.join(home, '.claude'), {
		skillOverrides: {
			'on-skill': 'on',
			'name-only-skill': 'name-only',
			'invocable-skill': 'user-invocable-only',
			'off-skill': 'off',
		},
	});

	const result = scanSkills({ home, projectRoot });
	const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]));

	assert.equal(byName['on-skill'].state, 'on');
	assert.equal(byName['name-only-skill'].state, 'name-only');
	assert.equal(byName['invocable-skill'].state, 'user-invocable-only');
	assert.equal(byName['off-skill'].state, 'off');
	for (const name of ['on-skill', 'name-only-skill', 'invocable-skill', 'off-skill']) {
		assert.equal(byName[name].stateSource, settingsPath);
		assert.ok(Number.isInteger(byName[name].stateLine));
		assert.equal(byName[name].stateLink, `vscode://file${settingsPath}:${byName[name].stateLine}`);
	}
});

test('local settings override beats project which beats user', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'cascade-skill', ['name: cascade-skill', 'description: d.']);

	writeSettings(path.join(home, '.claude'), { skillOverrides: { 'cascade-skill': 'off' } });
	writeSettings(path.join(projectRoot, '.claude'), { skillOverrides: { 'cascade-skill': 'name-only' } });
	writeLocalSettings(projectRoot, { skillOverrides: { 'cascade-skill': 'user-invocable-only' } });

	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'cascade-skill');
	assert.equal(skill.state, 'user-invocable-only');
	assert.equal(skill.stateSource, path.join(projectRoot, '.claude', 'settings.local.json'));
});

test('an override with no matching skill is reported as an orphan, not silently dropped', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'real-skill', ['name: real-skill', 'description: d.']);
	writeSettings(path.join(home, '.claude'), {
		skillOverrides: { 'real-skill': 'off', 'typo-skll': 'off' },
	});

	const result = scanSkills({ home, projectRoot });
	assert.equal(result.orphanOverrides.length, 1);
	assert.equal(result.orphanOverrides[0].name, 'typo-skll');
	assert.equal(result.orphanOverrides[0].layer, 'user');
	assert.equal(result.orphanOverrides[0].path, path.join(home, '.claude', 'settings.json'));
	assert.ok(Number.isInteger(result.orphanOverrides[0].line));
	assert.ok(result.orphanOverrides[0].link.startsWith('vscode://file'));
});

test('an identical skill shadowed across user and project scope is flagged, project wins', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const frontmatter = ['name: shared-skill', 'description: same everywhere.'];
	writeSkill(path.join(home, '.claude', 'skills'), 'shared-skill', frontmatter);
	writeSkill(path.join(projectRoot, '.claude', 'skills'), 'shared-skill', frontmatter);

	const result = scanSkills({ home, projectRoot });
	assert.equal(result.duplicates.length, 1);
	assert.equal(result.duplicates[0].name, 'shared-skill');
	assert.deepEqual([...result.duplicates[0].layers].sort(), ['project', 'user']);
	assert.equal(result.duplicates[0].identical, true);

	const userCopy = result.skills.find((s) => s.layer === 'user' && s.name === 'shared-skill');
	const projectCopy = result.skills.find((s) => s.layer === 'project' && s.name === 'shared-skill');
	assert.equal(userCopy.shadowedBy, 'project');
	assert.equal(projectCopy.shadowedBy, null);
});

test('a differing duplicate skill is flagged as not identical', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'drifted-skill', [
		'name: drifted-skill',
		'description: user version.',
	]);
	writeSkill(path.join(projectRoot, '.claude', 'skills'), 'drifted-skill', [
		'name: drifted-skill',
		'description: project version.',
	]);

	const result = scanSkills({ home, projectRoot });
	assert.equal(result.duplicates.length, 1);
	assert.equal(result.duplicates[0].identical, false);
});

test('disableBundledSkills is read from the cascade with its source', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSettings(path.join(projectRoot, '.claude'), { disableBundledSkills: true });

	const result = scanSkills({ home, projectRoot });
	assert.equal(result.disableBundledSkills.value, true);
	assert.equal(result.disableBundledSkills.sourcePath, path.join(projectRoot, '.claude', 'settings.json'));
	assert.ok(Number.isInteger(result.disableBundledSkills.sourceLine));
	assert.ok(result.disableBundledSkills.sourceLink.startsWith('vscode://file'));
});

test('disableBundledSkills defaults to false with no source when absent', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const result = scanSkills({ home, projectRoot });
	assert.equal(result.disableBundledSkills.value, false);
	assert.equal(result.disableBundledSkills.sourcePath, null);
	assert.equal(result.disableBundledSkills.sourceLine, null);
	assert.equal(result.disableBundledSkills.sourceLink, null);
});

test('an unreadable SKILL.md surfaces the real error and real path instead of being invented', () => {
	if (process.getuid && process.getuid() === 0) return; // root ignores permission bits
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const skillPath = writeSkill(path.join(home, '.claude', 'skills'), 'locked-skill', [
		'name: locked-skill',
		'description: d.',
	]);
	fs.chmodSync(skillPath, 0o000);
	try {
		const result = scanSkills({ home, projectRoot });
		const entry = result.skills.find((s) => s.path === skillPath);
		assert.ok(entry, 'the skill directory is still discovered even though the file cannot be read');
		assert.ok(entry.error && entry.error.length > 0);
		assert.equal(entry.description, '');
	} finally {
		fs.chmodSync(skillPath, 0o644);
	}
});

test('disable-model-invocation frontmatter is surfaced independently of skillOverrides state', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'silent-skill', [
		'name: silent-skill',
		'description: needs an explicit slash.',
		'disable-model-invocation: true',
	]);
	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'silent-skill');
	assert.equal(skill.disableModelInvocation, true);
	assert.equal(skill.state, 'on');
});

test('a multi-line folded description is joined into one string', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'folded-skill', [
		'name: folded-skill',
		'description: This description',
		'  keeps going',
		'  across several lines.',
	]);
	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'folded-skill');
	assert.equal(skill.description, 'This description keeps going across several lines.');
});

test('skillListingTotals counts only on/name-only skills and excludes the shadowed loser', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'vis-a', ['name: vis-a', 'description: aaaa']);
	writeSkill(path.join(home, '.claude', 'skills'), 'vis-b', ['name: vis-b', 'description: bbbb']);
	writeSkill(path.join(home, '.claude', 'skills'), 'hidden-c', ['name: hidden-c', 'description: cccc']);
	writeSettings(path.join(home, '.claude'), { skillOverrides: { 'hidden-c': 'off' } });
	// duplicate across scope: project wins, the shadowed user copy must not double count
	const dup = ['name: dup-skill', 'description: same content.'];
	writeSkill(path.join(home, '.claude', 'skills'), 'dup-skill', dup);
	writeSkill(path.join(projectRoot, '.claude', 'skills'), 'dup-skill', dup);

	const result = scanSkills({ home, projectRoot });
	const totals = skillListingTotals(result.skills);

	assert.equal(totals.countByState.on, 3); // vis-a, vis-b, dup-skill (project copy only)
	assert.equal(totals.countByState['name-only'] ?? 0, 0);
	assert.equal(totals.countByLayer.user, 2);
	assert.equal(totals.countByLayer.project, 1);

	const expectedChars = ['vis-a', 'vis-b', 'dup-skill'].reduce((sum, name) => {
		const skill = result.skills.find((s) => s.name === name && s.shadowedBy == null);
		return sum + skill.listingChars;
	}, 0);
	assert.equal(totals.totalChars, expectedChars);
	assert.ok(totals.estimatedTokens > 0);
});

test('a symlinked skill directory is discovered like a real one, marked isSymlink with its resolved target', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const realSkillDir = path.join(home, 'elsewhere', 'memory-capture');
	fs.mkdirSync(realSkillDir, { recursive: true });
	fs.writeFileSync(
		path.join(realSkillDir, 'SKILL.md'),
		['---', 'name: memory-capture', 'description: Capture memory.', '---', '\nBody.\n'].join('\n'),
	);
	const skillsDir = path.join(home, '.claude', 'skills');
	fs.mkdirSync(skillsDir, { recursive: true });
	fs.symlinkSync(realSkillDir, path.join(skillsDir, 'memory-capture'), 'dir');

	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'memory-capture');
	assert.ok(skill, 'the symlinked skill should be discovered');
	assert.equal(skill.layer, 'user');
	assert.equal(skill.description, 'Capture memory.');
	assert.equal(skill.isSymlink, true);
	assert.equal(skill.symlinkTarget, fs.realpathSync(realSkillDir));
});

test('a broken symlink under a skills directory is skipped, not reported as a skill', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const skillsDir = path.join(home, '.claude', 'skills');
	fs.mkdirSync(skillsDir, { recursive: true });
	fs.symlinkSync(path.join(home, 'does-not-exist'), path.join(skillsDir, 'ghost-skill'), 'dir');

	const result = scanSkills({ home, projectRoot });
	assert.equal(
		result.skills.find((s) => s.name === 'ghost-skill'),
		undefined,
	);
});

test('a skillOverrides entry on a symlinked skill is live: it takes the override state and orphanOverrides stays empty', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const realSkillDir = path.join(home, 'elsewhere', 'linked-skill');
	fs.mkdirSync(realSkillDir, { recursive: true });
	fs.writeFileSync(
		path.join(realSkillDir, 'SKILL.md'),
		['---', 'name: linked-skill', 'description: Linked.', '---', '\nBody.\n'].join('\n'),
	);
	const skillsDir = path.join(home, '.claude', 'skills');
	fs.mkdirSync(skillsDir, { recursive: true });
	fs.symlinkSync(realSkillDir, path.join(skillsDir, 'linked-skill'), 'dir');
	writeSettings(path.join(home, '.claude'), { skillOverrides: { 'linked-skill': 'name-only' } });

	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'linked-skill');
	assert.ok(skill);
	assert.equal(skill.isSymlink, true);
	assert.equal(skill.state, 'name-only');
	assert.deepEqual(result.orphanOverrides, []);
});

test('listingChars for a name-only skill counts only the name and overhead, not the description', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'quiet-skill', [
		'name: quiet-skill',
		'description: This description is long and should never be billed once the skill is name-only.',
	]);
	writeSettings(path.join(home, '.claude'), { skillOverrides: { 'quiet-skill': 'name-only' } });

	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'quiet-skill');
	assert.equal(skill.state, 'name-only');
	assert.equal(skill.listingChars, 'quiet-skill'.length + 8);
	assert.equal(skill.estimatedTokens, Math.round(skill.listingChars / 4));
});

test('listingChars caps the description at skillListingMaxDescChars resolved from the settings cascade', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const description = 'x'.repeat(50);
	writeSkill(path.join(home, '.claude', 'skills'), 'capped-skill', [
		'name: capped-skill',
		`description: ${description}`,
	]);
	writeSettings(path.join(home, '.claude'), { skillListingMaxDescChars: 10 });

	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'capped-skill');
	assert.equal(skill.description.length, 50);
	assert.equal(skill.listingChars, 'capped-skill'.length + 10 + 8);
	assert.equal(result.skillListingMaxDescChars.value, 10);
	assert.equal(result.skillListingMaxDescChars.sourcePath, path.join(home, '.claude', 'settings.json'));
});

test('listingChars keeps the full description when skillListingMaxDescChars is unset', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const description = 'y'.repeat(50);
	writeSkill(path.join(home, '.claude', 'skills'), 'uncapped-skill', [
		'name: uncapped-skill',
		`description: ${description}`,
	]);

	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'uncapped-skill');
	assert.equal(skill.listingChars, 'uncapped-skill'.length + 50 + 8);
	assert.equal(result.skillListingMaxDescChars.value, null);
});

test('skillListingMaxDescChars cascade: local beats project beats user', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'cascade-cap-skill', [
		'name: cascade-cap-skill',
		`description: ${'z'.repeat(30)}`,
	]);
	writeSettings(path.join(home, '.claude'), { skillListingMaxDescChars: 5 });
	writeSettings(path.join(projectRoot, '.claude'), { skillListingMaxDescChars: 15 });
	writeLocalSettings(projectRoot, { skillListingMaxDescChars: 20 });

	const result = scanSkills({ home, projectRoot });
	const skill = result.skills.find((s) => s.name === 'cascade-cap-skill');
	assert.equal(skill.listingChars, 'cascade-cap-skill'.length + 20 + 8);
	assert.equal(result.skillListingMaxDescChars.value, 20);
	assert.equal(result.skillListingMaxDescChars.sourcePath, path.join(projectRoot, '.claude', 'settings.local.json'));
});

test('a plugin skill is stamped with its cached version and whether that version is the live one', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit');
	for (const version of ['1.0.0', '2.0.0']) {
		writeSkill(path.join(parent, version, 'skills'), 'ranger', ['name: ranger', 'description: Ranges around.']);
	}
	// Claude Code touches `.in_use` on the version a session loaded.
	fs.mkdirSync(path.join(parent, '2.0.0', '.in_use'), { recursive: true });

	const rangers = scanSkills({ home, projectRoot }).skills.filter((s) => s.name === 'ranger');
	// The scanner reports what is on disk -- both copies exist and both are listed.
	assert.equal(rangers.length, 2);
	const byVersion = Object.fromEntries(rangers.map((s) => [s.pluginVersion, s]));
	assert.deepEqual(Object.keys(byVersion).sort(), ['1.0.0', '2.0.0']);
	assert.equal(byVersion['2.0.0'].activeVersion, true);
	assert.equal(byVersion['1.0.0'].activeVersion, false);
});

test('a user or project skill is not version-scoped and claims neither flag', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	writeSkill(path.join(home, '.claude', 'skills'), 'helper', ['name: helper', 'description: Helps.']);
	writeSkill(path.join(projectRoot, '.claude', 'skills'), 'reviewer', ['name: reviewer', 'description: Reviews.']);

	for (const skill of scanSkills({ home, projectRoot }).skills) {
		assert.equal(skill.pluginVersion, null);
		assert.equal(skill.activeVersion, null, 'only a plugin row can be a stale-version copy');
	}
});

test('with no .in_use marker anywhere, exactly one cached version is still called active', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit');
	for (const version of ['0.1.0', '0.2.0', '0.3.0']) {
		writeSkill(path.join(parent, version, 'skills'), 'ranger', ['name: ranger', 'description: Ranges around.']);
	}
	const rangers = scanSkills({ home, projectRoot }).skills.filter((s) => s.name === 'ranger');
	assert.equal(rangers.filter((s) => s.activeVersion === true).length, 1);
	assert.equal(rangers.find((s) => s.activeVersion === true).pluginVersion, '0.3.0');
});

test('every stale cached copy is flagged, so no two live rows share a qualified name', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit');
	for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '2.0.0']) {
		for (const name of ['ranger', 'scout']) {
			writeSkill(path.join(parent, version, 'skills'), name, [`name: ${name}`, 'description: Does things.']);
		}
	}
	const { skills } = scanSkills({ home, projectRoot });
	assert.equal(skills.length, 10, 'every copy on disk is still reported');

	const live = skills.filter((s) => s.activeVersion !== false);
	const names = live.map((s) => s.qualifiedName);
	assert.deepEqual(names.sort(), ['toolkit:ranger', 'toolkit:scout']);
	assert.equal(new Set(names).size, names.length, 'five cached versions must not read as five skills');
});

test('cached versions of one plugin are not reported as name duplicates', () => {
	const home = tmpRoot();
	const projectRoot = tmpRoot();
	const parent = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit');
	for (const version of ['1.0.0', '2.0.0']) {
		writeSkill(path.join(parent, version, 'skills'), 'ranger', ['name: ranger', 'description: Ranges around.']);
	}
	// `duplicates` means shadowing -- one scope silently beating another. Two
	// cached versions of the SAME plugin skill are not that, and a plugin skill
	// is namespaced anyway, so it never collides with a bare user/project name.
	assert.deepEqual(scanSkills({ home, projectRoot }).duplicates, []);
});
