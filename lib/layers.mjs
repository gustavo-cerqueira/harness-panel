/**
 * Layer definitions and absolute path resolution.
 *
 * PRECEDENCE IS NOT LISTING ORDER. The brief lists the layers as
 * enterprise > user > project > local, but that is the order you read them in,
 * not the order Claude Code resolves them in. The real settings cascade is
 *
 *     user  <  project  <  local        (later wins)
 *
 * with enterprise managed policy overriding all three. So a key set in
 * `.claude/settings.local.json` beats the same key in `~/.claude/settings.json`.
 * Rendering the brief's order as authority would make the panel confidently
 * wrong about which value is live — the exact failure it exists to prevent.
 *
 * `authority` drives the merge; `listOrder` drives the left nav.
 *
 * One documented exception: `permissions.defaultMode: "auto"` is honoured only
 * from managed policy, user settings, or a CLI flag. Project and local settings
 * may set any OTHER mode and win, but cannot grant auto mode, because those
 * files are repo-controllable. `AUTO_MODE_TRUSTED_LAYERS` records that.
 */
import path from 'node:path';

export const LAYERS = [
	{
		id: 'enterprise',
		label: 'Enterprise managed',
		listOrder: 1,
		authority: 100,
		note: 'Machine-wide policy. Overrides every other layer and cannot be changed from the repo.',
	},
	{
		id: 'user',
		label: 'User',
		listOrder: 2,
		authority: 20,
		note: 'Your personal defaults, applied in every project on this machine.',
	},
	{
		id: 'project',
		label: 'Project shared',
		listOrder: 3,
		authority: 30,
		note: 'Checked into the repo and shared with everyone who clones it.',
	},
	{
		id: 'local',
		label: 'Project local (per-machine)',
		listOrder: 4,
		authority: 40,
		note: 'Per-machine and git-untracked on purpose. Claude Code rewrites it on every "always allow". Do not track it.',
	},
	{
		id: 'worktree',
		label: 'Worktree',
		listOrder: 5,
		authority: 40,
		note: 'The same per-machine file inside each git worktree. Drifts independently.',
	},
	{
		id: 'plugin',
		label: 'Plugin / marketplace',
		listOrder: 6,
		authority: 10,
		note: 'Contributed by installed plugins. Enabled or disabled from the settings cascade.',
	},
];

/** Layers whose `permissions.defaultMode: "auto"` the CLI will honour. */
export const AUTO_MODE_TRUSTED_LAYERS = Object.freeze(['enterprise', 'user']);

/** Layers that participate in the settings cascade, weakest first. */
export const SETTINGS_CASCADE = Object.freeze(['user', 'project', 'local', 'enterprise']);

export function layerById(id) {
	return LAYERS.find((layer) => layer.id === id) ?? null;
}

/** Higher authority wins. Returns the winning layer id, or null if none given. */
export function winningLayer(layerIds) {
	let best = null;
	for (const id of layerIds ?? []) {
		const layer = layerById(id);
		if (!layer) continue;
		if (!best || layer.authority > best.authority) best = layer;
	}
	return best?.id ?? null;
}

/**
 * Absolute paths for every artifact the panel inspects.
 *
 * @param {{home: string, projectRoot: string}} options
 */
export function resolveLayerPaths({ home, projectRoot }) {
	if (typeof home !== 'string' || typeof projectRoot !== 'string') {
		throw new TypeError('resolveLayerPaths requires absolute home and projectRoot');
	}
	const userDir = path.join(home, '.claude');
	const projectDir = path.join(projectRoot, '.claude');

	return {
		enterprise: {
			managedSettings: '/Library/Application Support/ClaudeCode/managed-settings.json',
			managedSettingsDir: '/Library/Application Support/ClaudeCode/managed-settings.d',
		},
		user: {
			dir: userDir,
			memory: path.join(userDir, 'CLAUDE.md'),
			settings: path.join(userDir, 'settings.json'),
			settingsLocal: path.join(userDir, 'settings.local.json'),
			keybindings: path.join(userDir, 'keybindings.json'),
			scheduledTasks: path.join(userDir, 'scheduled_tasks.json'),
			hooksDir: path.join(userDir, 'hooks'),
			skillsDir: path.join(userDir, 'skills'),
			agentsDir: path.join(userDir, 'agents'),
			commandsDir: path.join(userDir, 'commands'),
			outputStylesDir: path.join(userDir, 'output-styles'),
			pluginsDir: path.join(userDir, 'plugins'),
			transcriptsDir: path.join(userDir, 'projects'),
			mcpAuthCache: path.join(userDir, 'mcp-needs-auth-cache.json'),
			globalConfig: path.join(home, '.claude.json'),
		},
		project: {
			root: projectRoot,
			dir: projectDir,
			memory: path.join(projectDir, 'CLAUDE.md'),
			settings: path.join(projectDir, 'settings.json'),
			launch: path.join(projectDir, 'launch.json'),
			agentsDir: path.join(projectDir, 'agents'),
			commandsDir: path.join(projectDir, 'commands'),
			hooksDir: path.join(projectDir, 'hooks'),
			skillsDir: path.join(projectDir, 'skills'),
			mcpJson: path.join(projectRoot, '.mcp.json'),
			agentsSymlink: path.join(projectRoot, 'AGENTS.md'),
			rulesDir: path.join(projectRoot, '.ai-config', 'shared', 'rules'),
		},
		local: {
			settings: path.join(projectDir, 'settings.local.json'),
		},
		plugin: {
			config: path.join(userDir, 'plugins', 'config.json'),
			cacheDir: path.join(userDir, 'plugins', 'cache'),
			reposDir: path.join(userDir, 'plugins', 'repos'),
		},
	};
}

/** Path of the per-machine settings file inside an arbitrary worktree root. */
export function worktreeSettingsPath(worktreeRoot) {
	return path.join(worktreeRoot, '.claude', 'settings.local.json');
}
