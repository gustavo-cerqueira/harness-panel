/**
 * Codex CLI layer definitions and absolute path resolution.
 *
 * Codex counterpart of `../layers.mjs`. Every Codex scanner reads THIS file
 * for where Codex's harness files live and how its layers are ordered, the
 * same way every Claude scanner reads `../layers.mjs` — one shared place,
 * not one copy per scanner.
 *
 * Codex has no enterprise-managed-policy layer and no per-machine "local"
 * settings file the way Claude Code does, so the layer set is smaller:
 *
 *     builtin  <  system  <  plugin  <  user  <  project      (later wins)
 *
 * `authority` drives the merge (see `codexWinningLayer`); `listOrder` drives
 * the left nav, and it is deliberately NOT the same sequence — user is read
 * first because it is the layer a person edits most often, but a
 * project-level AGENTS.md/skill still shadows a user-level one of the same
 * name, exactly like Claude's project layer shadows its user layer.
 *
 * `system` (skills bundled under `skills/.system/`) is the weakest layer
 * that still has real files on disk — it ships with the CLI, nobody authored
 * it locally. `builtin` sits even lower because it is not a file at all
 * (behavior compiled into the CLI binary), so it can never actually win or
 * lose a shadowing contest the way a discovered skill/hook/agent file does;
 * its authority value is a placeholder floor, not a claim about real
 * precedence.
 *
 * Unlike Claude Code, Codex's own documentation does not (yet) spell out
 * this precedence in one place. The `user`/`project`/`plugin` ordering
 * mirrors Claude's cascade, which Codex's project-overrides-user AGENTS.md
 * convention is known to match. The `system`/`builtin` placement is this
 * module's best-effort placement pending confirmation from Codex — fix it
 * HERE if real Codex behaviour turns out to differ.
 */
import path from 'node:path';

export const CODEX_LAYERS = [
	{
		id: 'user',
		label: 'User',
		listOrder: 1,
		authority: 20,
		note: 'Personal defaults under CODEX_HOME, plus the shared ~/.agents skills/plugins roots.',
	},
	{
		id: 'project',
		label: 'Project',
		listOrder: 2,
		authority: 30,
		note: 'Checked into the repo: the AGENTS.md chain, .codex/, and .agents/. Shared with everyone who clones it.',
	},
	{
		id: 'plugin',
		label: 'Plugin / marketplace',
		listOrder: 3,
		authority: 10,
		note: 'Contributed by installed Codex plugins from the marketplace cache under CODEX_HOME/plugins/cache.',
	},
	{
		id: 'system',
		label: 'System (bundled)',
		listOrder: 4,
		authority: 5,
		note: 'Skills bundled with the Codex CLI itself, under skills/.system. The weakest layer with a real file.',
	},
	{
		id: 'builtin',
		label: 'Built-in',
		listOrder: 5,
		authority: 1,
		note: 'Compiled into the CLI binary. No file on disk to inspect or shadow.',
	},
];

/**
 * Layers that participate in the settings cascade, weakest first.
 *
 * Codex's config precedence (`config.toml` layers, `--profile`, and CLI
 * flags) is not yet confirmed against Codex's own documentation the way
 * Claude's `SETTINGS_CASCADE` is. This is the best-effort ordering — weakest
 * first, `cli` flags winning last. Confirmed against Codex 0.149.1's own loader
 * order (config/src/loader/mod.rs, reported by Codex on 2026-08-26): user
 * config < selected `<profile>.config.toml` < trusted project `.codex/config.toml`
 * layers < runtime and `-c` overrides. THIS constant is the single place to fix
 * if a future release changes that order.
 */
export const CODEX_SETTINGS_CASCADE = Object.freeze(['user', 'profile', 'project', 'cli']);

/** Basenames the panel must never open, regardless of which layer holds them. */
export const NEVER_READ = Object.freeze(['auth.json']);

export function codexLayerById(id) {
	return CODEX_LAYERS.find((layer) => layer.id === id) ?? null;
}

/** Higher authority wins. Returns the winning layer id, or null if none given. */
export function codexWinningLayer(layerIds) {
	let best = null;
	for (const id of layerIds ?? []) {
		const layer = codexLayerById(id);
		if (!layer) continue;
		if (!best || layer.authority > best.authority) best = layer;
	}
	return best?.id ?? null;
}

/**
 * Absolute paths for every Codex artifact the panel inspects.
 *
 * @param {{home: string, projectRoot: string, codexHome?: string}} options
 *
 * `codexHome` defaults to `process.env.CODEX_HOME || path.join(home,
 * '.codex')`, matching Codex's own resolution rule, but an explicit
 * `codexHome` always wins over the environment variable.
 *
 * The two `~/.agents/*` roots (`user.agentsSkillsDir`, `user.agentsPluginsDir`)
 * are pinned to `home` rather than `codexHome` on purpose: Codex scans them
 * as a second, home-relative root independent of where CODEX_HOME points.
 *
 * `user.pluginsDir` / `pluginsCacheDir` / `pluginSourcesDir` live inside
 * CODEX_HOME, so they are listed under `user` (mirroring how everything else
 * CODEX_HOME-rooted is listed there). The top-level `plugin` group is the
 * layer-oriented shortcut for scanners that want "the plugin layer" without
 * reaching back into `user` for it — the same relationship Claude's
 * `resolveLayerPaths()` has between its `user` and `plugin` groups.
 */
export function resolveCodexPaths({ home, projectRoot, codexHome } = {}) {
	if (typeof home !== 'string' || typeof projectRoot !== 'string') {
		throw new TypeError('resolveCodexPaths requires absolute home and projectRoot');
	}
	const codexHomeDir =
		typeof codexHome === 'string' && codexHome.length > 0
			? codexHome
			: process.env.CODEX_HOME || path.join(home, '.codex');
	const agentsHomeDir = path.join(home, '.agents');
	const projectCodexDir = path.join(projectRoot, '.codex');
	const projectAgentsDir = path.join(projectRoot, '.agents');

	return {
		user: {
			dir: codexHomeDir,
			config: path.join(codexHomeDir, 'config.toml'),
			configFullAccess: path.join(codexHomeDir, 'full_access.config.toml'),
			memory: path.join(codexHomeDir, 'AGENTS.md'),
			hooksJson: path.join(codexHomeDir, 'hooks.json'),
			hooksDir: path.join(codexHomeDir, 'hooks'),
			skillsDir: path.join(codexHomeDir, 'skills'),
			systemSkillsDir: path.join(codexHomeDir, 'skills', '.system'),
			agentsSkillsDir: path.join(agentsHomeDir, 'skills'),
			agentsPluginsDir: path.join(agentsHomeDir, 'plugins'),
			promptsDir: path.join(codexHomeDir, 'prompts'),
			agentsDir: path.join(codexHomeDir, 'agents'),
			rulesDir: path.join(codexHomeDir, 'rules'),
			pluginsDir: path.join(codexHomeDir, 'plugins'),
			pluginsCacheDir: path.join(codexHomeDir, 'plugins', 'cache'),
			pluginSourcesDir: path.join(codexHomeDir, 'plugin-sources'),
			sessionsDir: path.join(codexHomeDir, 'sessions'),
			historyJsonl: path.join(codexHomeDir, 'history.jsonl'),
			sessionIndexJsonl: path.join(codexHomeDir, 'session_index.jsonl'),
			memoriesDir: path.join(codexHomeDir, 'memories'),
			modelsCache: path.join(codexHomeDir, 'models_cache.json'),
			versionJson: path.join(codexHomeDir, 'version.json'),
			globalState: path.join(codexHomeDir, '.codex-global-state.json'),
			authJson: path.join(codexHomeDir, 'auth.json'),
			oauthLocksDir: path.join(codexHomeDir, 'mcp-oauth-locks'),
		},
		project: {
			root: projectRoot,
			memory: path.join(projectRoot, 'AGENTS.md'),
			memoryOverride: path.join(projectRoot, 'AGENTS.override.md'),
			codexDir: projectCodexDir,
			config: path.join(projectCodexDir, 'config.toml'),
			hooksJson: path.join(projectCodexDir, 'hooks.json'),
			hooksDir: path.join(projectCodexDir, 'hooks'),
			agentsDir: path.join(projectCodexDir, 'agents'),
			skillsDir: path.join(projectCodexDir, 'skills'),
			agentsSkillsDir: path.join(projectAgentsDir, 'skills'),
			rulesDir: path.join(projectRoot, '.ai-config', 'shared', 'rules'),
		},
		plugin: {
			cacheDir: path.join(codexHomeDir, 'plugins', 'cache'),
			sourcesDir: path.join(codexHomeDir, 'plugin-sources'),
		},
	};
}
