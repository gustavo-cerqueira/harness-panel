import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSnapshots } from '../lib/snapshot-diff.mjs';

/**
 * Builds a minimal, structurally valid /api/state snapshot. Every section is
 * present with an empty/neutral payload unless overridden, so a test only
 * has to specify the one section it cares about.
 */
function baseState(overrides = {}) {
	const { projectRoot = '/repo', generatedAt = '2026-08-16T10:00:00.000Z', derived = null, sections = {} } = overrides;

	const defaultSections = {
		memory: { id: 'memory', label: 'Memory / instructions', ok: true, data: [] },
		settings: { id: 'settings', label: 'Settings', ok: true, data: { layers: [], keys: [], conflicts: [] } },
		hooks: { id: 'hooks', label: 'Hooks', ok: true, data: [] },
		skills: {
			id: 'skills',
			label: 'Skills',
			ok: true,
			data: { skills: [], duplicates: [], orphanOverrides: [], disableBundledSkills: { value: false } },
		},
		commands: { id: 'commands', label: 'Slash commands', ok: true, data: { commands: [], notes: [] } },
		agents: { id: 'agents', label: 'Subagents', ok: true, data: [] },
		mcp: { id: 'mcp', label: 'MCP servers', ok: true, data: { servers: [], sources: {} } },
		rules: {
			id: 'rules',
			label: 'Rules',
			ok: true,
			data: { rules: [], error: null, path: '/repo/.ai-config/shared/rules' },
		},
		plugins: { id: 'plugins', label: 'Plugins', ok: true, data: { plugins: [], sources: {} } },
		worktrees: { id: 'worktrees', label: 'Worktree drift', ok: true, data: { worktrees: [] } },
		injected: { id: 'injected', label: 'Injected context', ok: true, data: {} },
	};

	return {
		generatedAt,
		home: '/home/me',
		projectRoot,
		launchRoot: projectRoot,
		rootRejected: false,
		node: 'v22.21.1',
		sections: { ...defaultSections, ...sections },
		git: { available: false },
		derived: derived ?? { memory: null, skills: null, note: null },
		meta: { readOnly: true, baseSystemPrompt: 'x', sectionOrder: [] },
	};
}

function skillsSection(skills) {
	return {
		skills: {
			id: 'skills',
			label: 'Skills',
			ok: true,
			data: { skills, duplicates: [], orphanOverrides: [], disableBundledSkills: { value: false } },
		},
	};
}

function settingsSection(keys) {
	return { settings: { id: 'settings', label: 'Settings', ok: true, data: { layers: [], keys, conflicts: [] } } };
}

function pluginsSection(plugins) {
	return { plugins: { id: 'plugins', label: 'Plugins', ok: true, data: { plugins, sources: {} } } };
}

function mcpSection(servers) {
	return { mcp: { id: 'mcp', label: 'MCP servers', ok: true, data: { servers, sources: {} } } };
}

function hooksSection(hooks) {
	return { hooks: { id: 'hooks', label: 'Hooks', ok: true, data: hooks } };
}

function memorySection(entries) {
	return { memory: { id: 'memory', label: 'Memory / instructions', ok: true, data: entries } };
}

function agentsSection(agents) {
	return { agents: { id: 'agents', label: 'Subagents', ok: true, data: agents } };
}

function commandsSection(commands) {
	return { commands: { id: 'commands', label: 'Slash commands', ok: true, data: { commands, notes: [] } } };
}

function worktreesSection(worktrees) {
	return { worktrees: { id: 'worktrees', label: 'Worktree drift', ok: true, data: { worktrees } } };
}

function skill({ name, layer = 'project', plugin = null, state = 'on', shadowedBy = null }) {
	return {
		name,
		qualifiedName: plugin ? `${plugin}:${name}` : name,
		layer,
		plugin,
		path: `/repo/.claude/skills/${name}/SKILL.md`,
		line: 1,
		link: null,
		description: 'a skill',
		listingChars: 20,
		estimatedTokens: 5,
		disableModelInvocation: false,
		state,
		stateSource: null,
		stateLine: null,
		stateLink: null,
		shadowedBy,
		error: null,
	};
}

function settingKey({ key, effectiveValue, winningLayer, known = true, ownerOnly = false, secret = false }) {
	return { key, effectiveValue, winningLayer, known, ownerOnly, secret, perLayer: [], elements: null };
}

function plugin({ key, name, marketplace = 'demo-marketplace', version = '1.0.0', enabled = true }) {
	return {
		key,
		name,
		marketplace,
		version,
		path: `/home/me/.claude/plugins/cache/${marketplace}/${name}/${version}`,
		enabled,
		enabledSource: null,
		enabledLine: null,
		enabledLink: null,
		contributes: { skills: [], commands: [], agents: [], mcpServers: [], hooks: 0 },
		listingChars: 0,
		estimatedTokens: 0,
		error: null,
	};
}

test('diffSnapshots is pure and never throws on malformed input', () => {
	assert.doesNotThrow(() => diffSnapshots(undefined, undefined));
	assert.doesNotThrow(() => diffSnapshots(null, null));
	assert.doesNotThrow(() => diffSnapshots('garbage', 42));
	assert.doesNotThrow(() => diffSnapshots({}, []));
});

test('missing before yields comparable:false with a reason', () => {
	const after = baseState();
	const result = diffSnapshots(null, after);
	assert.equal(result.meta.comparable, false);
	assert.equal(typeof result.meta.reason, 'string');
	assert.ok(result.meta.reason.length > 0);
	assert.equal(result.summary.added, 0);
	assert.equal(result.summary.removed, 0);
	assert.equal(result.summary.changed, 0);
	assert.deepEqual(result.sections, []);
	assert.ok(result.headline.length > 0);
});

test('garbage before (not a state object) yields comparable:false', () => {
	const after = baseState();
	const result = diffSnapshots({ nonsense: true }, after);
	assert.equal(result.meta.comparable, false);
	assert.ok(result.meta.reason.includes('before'));
});

test('two valid comparable states report comparable:true and the raw meta fields', () => {
	const before = baseState({ generatedAt: '2026-08-16T10:00:00.000Z' });
	const after = baseState({ generatedAt: '2026-08-17T10:00:00.000Z' });
	const result = diffSnapshots(before, after);
	assert.equal(result.meta.comparable, true);
	assert.equal(result.meta.beforeAt, '2026-08-16T10:00:00.000Z');
	assert.equal(result.meta.afterAt, '2026-08-17T10:00:00.000Z');
	assert.equal(result.meta.reason, null);
});

test('comparing two different projectRoots sets sameRoot:false without breaking comparability', () => {
	const before = baseState({ projectRoot: '/repo-a' });
	const after = baseState({ projectRoot: '/repo-b' });
	const result = diffSnapshots(before, after);
	assert.equal(result.meta.comparable, true);
	assert.equal(result.meta.beforeRoot, '/repo-a');
	assert.equal(result.meta.afterRoot, '/repo-b');
	assert.equal(result.meta.sameRoot, false);
});

test('same projectRoot sets sameRoot:true', () => {
	const before = baseState({ projectRoot: '/repo' });
	const after = baseState({ projectRoot: '/repo' });
	const result = diffSnapshots(before, after);
	assert.equal(result.meta.sameRoot, true);
});

test('an added skill is reported in the skills section and the summary', () => {
	const before = baseState({ sections: skillsSection([]) });
	const after = baseState({ sections: skillsSection([skill({ name: 'graphify' })]) });
	const result = diffSnapshots(before, after);
	const skillsOut = result.sections.find((s) => s.id === 'skills');
	assert.equal(skillsOut.added.length, 1);
	assert.equal(skillsOut.added[0].key, 'graphify');
	assert.equal(skillsOut.removed.length, 0);
	assert.equal(skillsOut.counts.added, 1);
	assert.equal(result.summary.added, 1);
});

test('a removed skill is reported in the skills section and the summary', () => {
	const before = baseState({ sections: skillsSection([skill({ name: 'graphify' })]) });
	const after = baseState({ sections: skillsSection([]) });
	const result = diffSnapshots(before, after);
	const skillsOut = result.sections.find((s) => s.id === 'skills');
	assert.equal(skillsOut.removed.length, 1);
	assert.equal(skillsOut.removed[0].key, 'graphify');
	assert.equal(result.summary.removed, 1);
});

test('a skill turning off then on is a changed entry and appears in headline', () => {
	const before = baseState({ sections: skillsSection([skill({ name: 'graphify', state: 'off' })]) });
	const after = baseState({ sections: skillsSection([skill({ name: 'graphify', state: 'on' })]) });
	const result = diffSnapshots(before, after);
	const skillsOut = result.sections.find((s) => s.id === 'skills');
	assert.equal(skillsOut.changed.length, 1);
	assert.equal(skillsOut.changed[0].key, 'graphify');
	assert.equal(skillsOut.changed[0].before.state, 'off');
	assert.equal(skillsOut.changed[0].after.state, 'on');
	assert.equal(result.summary.changed, 1);
	assert.ok(
		result.headline.some((line) => /graphify/.test(line) && /turned on/i.test(line)),
		`expected a "turned on" headline for graphify, got: ${JSON.stringify(result.headline)}`,
	);
});

test('a setting whose VALUE changed (layer unchanged) is a changed entry with a headline', () => {
	const before = baseState({
		sections: settingsSection([settingKey({ key: 'model', effectiveValue: 'sonnet', winningLayer: 'user' })]),
	});
	const after = baseState({
		sections: settingsSection([settingKey({ key: 'model', effectiveValue: 'opus', winningLayer: 'user' })]),
	});
	const result = diffSnapshots(before, after);
	const settingsOut = result.sections.find((s) => s.id === 'settings');
	assert.equal(settingsOut.changed.length, 1);
	assert.equal(settingsOut.changed[0].before.effectiveValue, 'sonnet');
	assert.equal(settingsOut.changed[0].after.effectiveValue, 'opus');
	assert.ok(result.headline.some((line) => line.includes('model') && line.includes('sonnet') && line.includes('opus')));
});

test('a setting whose WINNING LAYER changed while the value stayed identical is a changed entry, ranked above a plain value change, and named in headline', () => {
	const before = baseState({
		sections: settingsSection([
			settingKey({ key: 'permissions.defaultMode', effectiveValue: 'plan', winningLayer: 'user' }),
			settingKey({ key: 'theme', effectiveValue: 'dark', winningLayer: 'user' }),
		]),
	});
	const after = baseState({
		sections: settingsSection([
			settingKey({ key: 'permissions.defaultMode', effectiveValue: 'plan', winningLayer: 'local' }),
			settingKey({ key: 'theme', effectiveValue: 'light', winningLayer: 'user' }),
		]),
	});
	const result = diffSnapshots(before, after);
	const settingsOut = result.sections.find((s) => s.id === 'settings');
	const layerChange = settingsOut.changed.find((c) => c.key === 'permissions.defaultMode');
	assert.ok(layerChange, 'expected permissions.defaultMode to be a changed entry even though its value is identical');
	assert.equal(layerChange.before.effectiveValue, layerChange.after.effectiveValue);
	assert.equal(layerChange.before.winningLayer, 'user');
	assert.equal(layerChange.after.winningLayer, 'local');

	const layerHeadlineIndex = result.headline.findIndex(
		(line) => line.includes('permissions.defaultMode') && /winning layer changed/i.test(line),
	);
	const valueHeadlineIndex = result.headline.findIndex((line) => line.includes('theme') && line.includes('dark'));
	assert.ok(layerHeadlineIndex !== -1, `expected a winning-layer headline, got: ${JSON.stringify(result.headline)}`);
	assert.ok(
		valueHeadlineIndex !== -1,
		`expected a value-change headline for theme, got: ${JSON.stringify(result.headline)}`,
	);
	assert.ok(layerHeadlineIndex < valueHeadlineIndex, 'winning-layer drift must rank above a plain value change');
});

test('a plugin flipping enabled->disabled is a changed entry with a high-ranked headline', () => {
	const before = baseState({
		sections: pluginsSection([plugin({ key: 'graphify@demo-marketplace', name: 'graphify', enabled: true })]),
	});
	const after = baseState({
		sections: pluginsSection([plugin({ key: 'graphify@demo-marketplace', name: 'graphify', enabled: false })]),
	});
	const result = diffSnapshots(before, after);
	const pluginsOut = result.sections.find((s) => s.id === 'plugins');
	assert.equal(pluginsOut.changed.length, 1);
	assert.equal(pluginsOut.changed[0].before.enabled, true);
	assert.equal(pluginsOut.changed[0].after.enabled, false);
	assert.ok(result.headline.some((line) => line.includes('graphify') && /disabled/i.test(line)));
});

test('an MCP server disabling is a changed entry with a headline', () => {
	const before = baseState({
		sections: mcpSection([
			{
				name: 'playwright',
				normalizedName: 'playwright',
				scope: 'user',
				transport: 'stdio',
				disabled: false,
				command: 'npx',
				args: [],
				url: null,
				envKeys: [],
				env: {},
				headers: {},
				sourcePath: '/x',
				line: 1,
				link: null,
				disabledSource: null,
				needsAuth: null,
				authCacheMtime: null,
				error: null,
			},
		]),
	});
	const after = baseState({
		sections: mcpSection([
			{
				name: 'playwright',
				normalizedName: 'playwright',
				scope: 'user',
				transport: 'stdio',
				disabled: true,
				command: 'npx',
				args: [],
				url: null,
				envKeys: [],
				env: {},
				headers: {},
				sourcePath: '/x',
				line: 1,
				link: null,
				disabledSource: null,
				needsAuth: null,
				authCacheMtime: null,
				error: null,
			},
		]),
	});
	const result = diffSnapshots(before, after);
	const mcpOut = result.sections.find((s) => s.id === 'mcp');
	assert.equal(mcpOut.changed.length, 1);
	assert.equal(mcpOut.changed[0].key, 'user:playwright');
	assert.ok(result.headline.some((line) => line.includes('playwright') && /disabled/i.test(line)));
});

test('a hook whose script disappeared is a changed entry with a headline', () => {
	const hookRow = (scriptExists) => ({
		layer: 'project',
		event: 'PreToolUse',
		matcher: 'Write',
		type: 'command',
		command: 'bash .claude/hooks/require-spec-lock.sh',
		timeout: null,
		sourcePath: '/repo/.claude/settings.json',
		line: 5,
		link: null,
		scriptPath: '/repo/.claude/hooks/require-spec-lock.sh',
		scriptExists,
		scriptExecutable: true,
		scriptError: null,
		resolvedFrom: 'CLAUDE_PROJECT_DIR',
		escapeHatches: [],
	});
	const before = baseState({ sections: hooksSection([hookRow(true)]) });
	const after = baseState({ sections: hooksSection([hookRow(false)]) });
	const result = diffSnapshots(before, after);
	const hooksOut = result.sections.find((s) => s.id === 'hooks');
	assert.equal(hooksOut.changed.length, 1);
	assert.equal(hooksOut.changed[0].before.scriptExists, true);
	assert.equal(hooksOut.changed[0].after.scriptExists, false);
	assert.ok(result.headline.some((line) => line.includes('require-spec-lock.sh') && /vanish/i.test(line)));
});

test('memory bytes movement is a changed entry', () => {
	const entry = (bytes) => ({
		layer: 'user',
		path: '/home/me/.claude/CLAUDE.md',
		exists: true,
		isSymlink: false,
		symlinkTarget: null,
		bytes,
		estimatedTokens: Math.round(bytes / 4),
		alwaysInjected: true,
		content: null,
		headings: [],
		link: null,
		error: null,
		tripsLargeFileWarning: false,
		scopeDir: null,
	});
	const before = baseState({ sections: memorySection([entry(1000)]) });
	const after = baseState({ sections: memorySection([entry(1500)]) });
	const result = diffSnapshots(before, after);
	const memoryOut = result.sections.find((s) => s.id === 'memory');
	assert.equal(memoryOut.changed.length, 1);
	assert.equal(memoryOut.changed[0].before.bytes, 1000);
	assert.equal(memoryOut.changed[0].after.bytes, 1500);
});

test('an agent model change is a changed entry', () => {
	const agent = (model) => ({
		name: 'backend-reviewer',
		layer: 'project',
		plugin: null,
		path: '/repo/.claude/agents/backend-reviewer.md',
		line: 1,
		link: null,
		description: 'reviews backend changes',
		model,
		tools: [],
		bytes: 500,
		valid: true,
		invalidReason: null,
		error: null,
	});
	const before = baseState({ sections: agentsSection([agent('sonnet')]) });
	const after = baseState({ sections: agentsSection([agent('opus')]) });
	const result = diffSnapshots(before, after);
	const agentsOut = result.sections.find((s) => s.id === 'agents');
	assert.equal(agentsOut.changed.length, 1);
	assert.equal(agentsOut.changed[0].before.model, 'sonnet');
	assert.equal(agentsOut.changed[0].after.model, 'opus');
});

test('a command flipping disable-model-invocation is a changed entry', () => {
	const command = (disableModelInvocation) => ({
		name: 'codex:review',
		layer: 'plugin',
		path: '/x/review.md',
		line: 1,
		link: null,
		description: 'review',
		disableModelInvocation,
		argumentHint: null,
		allowedTools: null,
		bytes: 200,
		error: null,
	});
	const before = baseState({ sections: commandsSection([command(false)]) });
	const after = baseState({ sections: commandsSection([command(true)]) });
	const result = diffSnapshots(before, after);
	const commandsOut = result.sections.find((s) => s.id === 'commands');
	assert.equal(commandsOut.changed.length, 1);
});

test('a worktree driftKind change is a changed entry', () => {
	const worktree = (driftKind) => ({
		path: '/repo-wt-x',
		branch: 'refs/heads/fix/x',
		head: 'abc',
		isMain: false,
		isCurrent: false,
		settingsPath: '/repo-wt-x/.claude/settings.local.json',
		exists: true,
		sha256: 'abc',
		bytes: 10,
		drifted: driftKind !== 'same',
		driftKind,
		link: null,
		error: null,
	});
	const before = baseState({ sections: worktreesSection([worktree('same')]) });
	const after = baseState({ sections: worktreesSection([worktree('different')]) });
	const result = diffSnapshots(before, after);
	const worktreesOut = result.sections.find((s) => s.id === 'worktrees');
	assert.equal(worktreesOut.changed.length, 1);
});

test('two unchanged reads produce summary.changed === 0 and no false positives', () => {
	const shared = {
		sections: {
			...skillsSection([skill({ name: 'graphify' }), skill({ name: 'diagnose' })]),
			...settingsSection([settingKey({ key: 'model', effectiveValue: 'sonnet', winningLayer: 'user' })]),
			...pluginsSection([plugin({ key: 'graphify@demo-marketplace', name: 'graphify' })]),
		},
	};
	const before = baseState(shared);
	const after = baseState(shared);
	const result = diffSnapshots(before, after);
	assert.equal(result.summary.added, 0);
	assert.equal(result.summary.removed, 0);
	assert.equal(result.summary.changed, 0);
	assert.ok(result.summary.unchanged > 0);
});

test('derived token-cost movement appears in headline, using the effective (not discovered) skill numbers', () => {
	const before = baseState({
		derived: {
			memory: { alwaysInjectedFiles: 1, alwaysInjectedBytes: 4000, estimatedTokens: 1000, onDemandFiles: 0 },
			skills: {
				discovered: { count: 50, chars: 40000, estimatedTokens: 10000 },
				effective: { count: 20, chars: 13292, estimatedTokens: 3323 },
				excluded: { hiddenByOverride: 0, shadowed: 0, staleOrDisabledPlugin: 0 },
			},
			note: 'x',
			totalEstimatedTokens: 4323,
		},
	});
	const after = baseState({
		derived: {
			memory: { alwaysInjectedFiles: 1, alwaysInjectedBytes: 4000, estimatedTokens: 1000, onDemandFiles: 0 },
			skills: {
				discovered: { count: 90, chars: 90000, estimatedTokens: 22500 },
				effective: { count: 16, chars: 11920, estimatedTokens: 2980 },
				excluded: { hiddenByOverride: 0, shadowed: 0, staleOrDisabledPlugin: 0 },
			},
			note: 'x',
			totalEstimatedTokens: 3980,
		},
	});
	const result = diffSnapshots(before, after);
	assert.ok(
		result.headline.some((line) => line.includes('4,323') && line.includes('3,980') && line.includes('-343')),
		`expected the effective-token movement in headline, got: ${JSON.stringify(result.headline)}`,
	);
	// The discovered-count swing (50->90) must NOT be what drives the headline number.
	assert.ok(!result.headline.some((line) => line.includes('10,000') || line.includes('22,500')));
});

test('a section present in one snapshot but not the other is reported, not skipped', () => {
	const before = baseState();
	delete before.sections.plugins;
	const after = baseState({
		sections: pluginsSection([plugin({ key: 'graphify@demo-marketplace', name: 'graphify' })]),
	});
	const result = diffSnapshots(before, after);
	const pluginsOut = result.sections.find((s) => s.id === 'plugins');
	assert.ok(pluginsOut, 'the plugins section must still be reported even though before had none');
	assert.equal(pluginsOut.added.length, 1);
});

test('a section whose payload shape is unrecognisable is flagged in headline, never silently dropped', () => {
	const before = baseState({ sections: hooksSection([]) });
	const after = baseState();
	after.sections.hooks = { id: 'hooks', label: 'Hooks', ok: true, data: 'not-an-array' };
	const result = diffSnapshots(before, after);
	const hooksOut = result.sections.find((s) => s.id === 'hooks');
	assert.ok(hooksOut, 'hooks section must still appear');
	assert.equal(hooksOut.counts.added, 0);
	assert.equal(hooksOut.counts.removed, 0);
	assert.equal(hooksOut.counts.changed, 0);
	assert.ok(result.headline.some((line) => /hooks/i.test(line) && /could not be compared/i.test(line)));
});

test('diffSnapshots is deterministic: same inputs twice produce deepEqual outputs', () => {
	const before = baseState({
		sections: {
			...skillsSection([skill({ name: 'graphify', state: 'off' }), skill({ name: 'diagnose' })]),
			...settingsSection([
				settingKey({ key: 'model', effectiveValue: 'sonnet', winningLayer: 'user' }),
				settingKey({ key: 'permissions.defaultMode', effectiveValue: 'plan', winningLayer: 'user' }),
			]),
			...pluginsSection([plugin({ key: 'graphify@demo-marketplace', name: 'graphify', enabled: true })]),
		},
	});
	const after = baseState({
		sections: {
			...skillsSection([skill({ name: 'graphify', state: 'on' }), skill({ name: 'council' })]),
			...settingsSection([
				settingKey({ key: 'model', effectiveValue: 'opus', winningLayer: 'user' }),
				settingKey({ key: 'permissions.defaultMode', effectiveValue: 'plan', winningLayer: 'local' }),
			]),
			...pluginsSection([plugin({ key: 'graphify@demo-marketplace', name: 'graphify', enabled: false })]),
		},
	});
	const result1 = diffSnapshots(before, after);
	const result2 = diffSnapshots(before, after);
	assert.deepEqual(result1, result2);
});

test('never mutates its inputs', () => {
	const before = baseState({ sections: skillsSection([skill({ name: 'graphify', state: 'off' })]) });
	const after = baseState({ sections: skillsSection([skill({ name: 'graphify', state: 'on' })]) });
	const beforeClone = JSON.parse(JSON.stringify(before));
	const afterClone = JSON.parse(JSON.stringify(after));
	diffSnapshots(before, after);
	assert.deepEqual(before, beforeClone);
	assert.deepEqual(after, afterClone);
});
