import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeCodexSettings } from '../lib/codex/settings-merge.mjs';

function tmpRoot(tag) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `harness-codex-settings-${tag}-`));
}

function write(absPath, content) {
	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, content);
}

const USER_CONFIG = [
	'model = "gpt-5.6-terra"',
	'model_reasoning_effort = "high"',
	'service_tier = "priority"',
	'approval_policy = "on-request"',
	'notify = ["/opt/notify-hook", "turn-ended"]',
	'',
	'[mcp_servers.demo]',
	'command = "node"',
	'bearer_token_env_var = "DEMO_TOKEN"',
	'',
	'[mcp_servers.demo.env]',
	'DEMO_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz01"',
	'DEMO_MODE = "verbose"',
	'',
	'[mcp_servers.demo.env_http_headers]',
	'Authorization = "Bearer plain-looking-value"',
	'',
	'[hooks.state."/tmp/hooks.json:session_start:0:0"]',
	'trusted_hash = "sha256:abc123"',
	'',
].join('\n');

const PROFILE_CONFIG = [
	'model = "gpt-profile-only"',
	'',
	'[mcp_servers.demo.tools.browser_click]',
	'approval_mode = "approve"',
	'',
].join('\n');

const PROJECT_CONFIG = [
	'model = "gpt-from-project"',
	'notify = ["/repo/evil-notify"]',
	'',
	'[features]',
	'respect_system_proxy = false',
	'',
	'[realtime]',
	'endpoint = "wss://repo.example/realtime"',
	'',
].join('\n');

function rolloutLines(projectRoot) {
	return [
		JSON.stringify({
			timestamp: '2026-08-26T10:00:00Z',
			type: 'session_meta',
			payload: { session_id: 's1', cwd: projectRoot },
		}),
		JSON.stringify({
			timestamp: '2026-08-26T10:00:01Z',
			type: 'turn_context',
			payload: { cwd: projectRoot, model: 'gpt-stale', effort: 'low', approval_policy: 'untrusted' },
		}),
		JSON.stringify({
			timestamp: '2026-08-26T10:00:02Z',
			type: 'response_item',
			payload: { type: 'message', role: 'user' },
		}),
		JSON.stringify({
			timestamp: '2026-08-26T10:00:03Z',
			type: 'turn_context',
			payload: {
				cwd: projectRoot,
				model: 'gpt-runtime',
				effort: 'xhigh',
				approval_policy: 'never',
				sandbox_policy: { type: 'danger-full-access' },
				permission_profile: { type: 'disabled' },
			},
		}),
		'',
	].join('\n');
}

/**
 * Builds a full fixture. `withRollout: false` leaves the sessions dir empty so
 * the "no runtime state observed" branch can be tested against the same files.
 */
function fixture(tag, { withRollout = true, withProject = true } = {}) {
	const home = tmpRoot(`${tag}-home`);
	const projectRoot = tmpRoot(`${tag}-repo`);
	const codexHome = path.join(home, '.codex');

	write(path.join(codexHome, 'config.toml'), USER_CONFIG);
	write(path.join(codexHome, 'full_access.config.toml'), PROFILE_CONFIG);
	if (withProject) write(path.join(projectRoot, '.codex', 'config.toml'), PROJECT_CONFIG);
	fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
	if (withRollout) {
		write(
			path.join(codexHome, 'sessions', '2026', '08', '26', 'rollout-2026-08-26T10-00-00-abc.jsonl'),
			rolloutLines(projectRoot),
		);
	}

	return { home, projectRoot, codexHome };
}

const keyOf = (result, key) => result.keys.find((row) => row.key === key);
const layerOf = (result, id) => result.layers.find((row) => row.layer === id);

test('layers name every cascade step, including the two that have no config file of their own', async () => {
	const { home, projectRoot, codexHome } = fixture('layers');
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	assert.deepEqual(
		result.layers.map((row) => row.layer),
		['user', 'profile', 'project', 'cli', 'runtime'],
	);

	const user = layerOf(result, 'user');
	assert.equal(user.exists, true);
	assert.equal(user.readable, true);
	assert.ok(user.keyCount > 5, `expected the user config to contribute keys, got ${user.keyCount}`);
	assert.equal(user.error, null);
	// `id` is the Claude layer-row field name, `layer` the Codex one. Both ship.
	assert.equal(user.id, 'user');

	const cli = layerOf(result, 'cli');
	assert.equal(cli.path, null);
	assert.equal(cli.exists, false);
	assert.match(cli.note, /-c key=value and UI overrides are per-session and not on disk/);
});

test('a nested table flattens to dotted keys that deep-link to their real line', async () => {
	const { home, projectRoot, codexHome } = fixture('nested');
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	const command = keyOf(result, 'mcp_servers.demo.command');
	assert.ok(command, 'expected mcp_servers.demo.command to be flattened out of [mcp_servers.demo]');
	assert.equal(command.effectiveValue, 'node');
	assert.equal(command.winningLayer, 'user');
	assert.equal(command.line ?? command.perLayer[0].line, 8);
	assert.equal(command.perLayer[0].link, `vscode://file${path.join(codexHome, 'config.toml')}:8`);

	// A quoted table name survives as one segment rather than splitting on the dots inside it.
	const trusted = keyOf(result, 'hooks.state."/tmp/hooks.json:session_start:0:0".trusted_hash');
	assert.ok(trusted, 'expected the quoted hooks.state table name to stay one key segment');
});

test('known is null on every key, because Codex ships no schema to check one against', async () => {
	const { home, projectRoot, codexHome } = fixture('known');
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	assert.ok(result.keys.length > 0);
	for (const row of result.keys) assert.equal(row.known, null, `${row.key} claimed a known state`);
	assert.ok(
		result.notes.some((note) => note.includes('no settings schema')),
		'expected a note explaining why known is never claimed',
	);
});

test('env values are masked by key name, and an *_env_var NAME is left readable', async () => {
	const { home, projectRoot, codexHome } = fixture('mask');
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	const secret = keyOf(result, 'mcp_servers.demo.env.DEMO_API_KEY');
	assert.equal(secret.secret, true);
	assert.notEqual(secret.effectiveValue, 'sk-abcdefghijklmnopqrstuvwxyz01');
	assert.match(String(secret.effectiveValue), /…/);

	// Ordinary configuration inside an env block stays readable — that is what
	// the panel is for.
	assert.equal(keyOf(result, 'mcp_servers.demo.env.DEMO_MODE').effectiveValue, 'verbose');
	// The variable NAME is not the token; masking it would hide a fact and protect nothing.
	assert.equal(keyOf(result, 'mcp_servers.demo.bearer_token_env_var').effectiveValue, 'DEMO_TOKEN');

	// A header value matches no secret-looking name and no vendor shape, so the
	// header table has to be masked wholesale or it leaks.
	const header = keyOf(result, 'mcp_servers.demo.env_http_headers.Authorization');
	assert.equal(header.secret, true);
	assert.notEqual(header.effectiveValue, 'Bearer plain-looking-value');
});

test('a profile is listed but never wins, and says which flag would activate it', async () => {
	const { home, projectRoot, codexHome } = fixture('profile');
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	const profileLayer = layerOf(result, 'profile');
	assert.equal(profileLayer.exists, true);
	assert.equal(profileLayer.path, path.join(codexHome, 'full_access.config.toml'));

	const model = keyOf(result, 'model');
	const fromProfile = model.perLayer.find((entry) => entry.layer === 'profile');
	assert.ok(fromProfile, 'expected the profile entry to be reported, not dropped');
	assert.equal(fromProfile.ignored, true);
	assert.equal(fromProfile.ignoredReason, 'profile "full_access" applies only with --profile full_access');
	assert.notEqual(model.winningLayer, 'profile');

	// A key ONLY a profile sets has no winner at all — nothing is in force.
	const profileOnly = keyOf(result, 'mcp_servers.demo.tools.browser_click.approval_mode');
	assert.equal(profileOnly.winningLayer, null);
	assert.equal(profileOnly.effectiveValue, null);
});

test('denylisted project keys are reported as present and ignored, not deleted', async () => {
	const { home, projectRoot, codexHome } = fixture('deny');
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	const notify = keyOf(result, 'notify');
	const fromProject = notify.perLayer.find((entry) => entry.layer === 'project');
	assert.ok(fromProject, 'expected the repo notify entry to still be visible');
	assert.equal(fromProject.ignored, true);
	assert.equal(fromProject.ignoredReason, 'denied from project config');
	assert.equal(notify.winningLayer, 'user');
	assert.deepEqual(notify.effectiveValue, ['/opt/notify-hook', 'turn-ended']);

	const proxy = keyOf(result, 'features.respect_system_proxy');
	assert.equal(proxy.perLayer[0].ignored, true);
	assert.equal(proxy.winningLayer, null);

	const realtime = keyOf(result, 'realtime.endpoint');
	assert.equal(realtime.perLayer[0].ignored, true);
	assert.match(realtime.perLayer[0].ignoredReason, /unverified/);

	// An allowed project key still beats the user layer.
	assert.equal(
		keyOf(result, 'model').perLayer.some((entry) => entry.layer === 'project' && entry.ignored === false),
		true,
	);
});

test('the tail-most turn_context of the newest matching rollout wins, key by key', async () => {
	const { home, projectRoot, codexHome } = fixture('runtime');
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	const runtimeLayer = layerOf(result, 'runtime');
	assert.equal(runtimeLayer.exists, true);
	assert.match(runtimeLayer.path, /rollout-2026-08-26T10-00-00-abc\.jsonl$/);
	assert.equal(runtimeLayer.keyCount, 5);

	const model = keyOf(result, 'model');
	assert.equal(model.winningLayer, 'runtime');
	// The FIRST turn_context said gpt-stale; only the last one counts.
	assert.equal(model.effectiveValue, 'gpt-runtime');

	assert.equal(keyOf(result, 'model_reasoning_effort').effectiveValue, 'xhigh');
	assert.equal(keyOf(result, 'approval_policy').effectiveValue, 'never');
	assert.equal(keyOf(result, 'sandbox_mode').effectiveValue, 'danger-full-access');
	assert.equal(keyOf(result, 'permission_profile').effectiveValue, 'disabled');

	// service_tier is absent from turn_context, so no runtime entry is invented
	// and the config value stands.
	const tier = keyOf(result, 'service_tier');
	assert.equal(tier.winningLayer, 'user');
	assert.equal(tier.effectiveValue, 'priority');
	assert.equal(
		tier.perLayer.some((entry) => entry.layer === 'runtime'),
		false,
	);

	assert.ok(model.perLayer.find((entry) => entry.layer === 'runtime').note.includes('/model'));
});

test('a rollout from another project is skipped rather than borrowed', async () => {
	const { home, projectRoot, codexHome } = fixture('foreign');
	write(
		path.join(codexHome, 'sessions', '2026', '08', '27', 'rollout-foreign.jsonl'),
		[
			JSON.stringify({ type: 'session_meta', payload: { cwd: '/somewhere/else' } }),
			JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-not-ours' } }),
			'',
		].join('\n'),
	);

	const result = await mergeCodexSettings({ home, projectRoot, codexHome });
	assert.equal(keyOf(result, 'model').effectiveValue, 'gpt-runtime');
});

test('turn_context ordered before session_meta cannot leak state when the cwd mismatches', async () => {
	const { home, projectRoot, codexHome } = fixture('reordered-mismatch');
	const reorderedPath = path.join(codexHome, 'sessions', '2026', '08', '28', 'rollout-reordered.jsonl');
	write(
		reorderedPath,
		[
			// Out of order: a turn_context arrives BEFORE session_meta ever proves the cwd.
			JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-leaked-before-check' } }),
			JSON.stringify({ type: 'session_meta', payload: { session_id: 's2', cwd: '/somewhere/else' } }),
			JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-also-leaked-after-mismatch' } }),
			'',
		].join('\n'),
	);
	// Force this file to be the NEWEST (probed first): the finding only holds if
	// scanRollout itself refuses the leak, not if probe order happens to skip it.
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(reorderedPath, future, future);

	const result = await mergeCodexSettings({ home, projectRoot, codexHome });
	// The mismatched/reordered rollout must not win: neither the pre-check nor
	// the post-mismatch turn_context may surface as runtime state, so the
	// 'runtime' fixture's own (older, matching) rollout wins instead.
	assert.equal(keyOf(result, 'model').effectiveValue, 'gpt-runtime');
});

test('a rollout with no session_meta at all never contributes a runtime layer', async () => {
	const { home, projectRoot, codexHome } = fixture('no-session-meta', { withRollout: false });
	write(
		path.join(codexHome, 'sessions', '2026', '08', '28', 'rollout-no-meta.jsonl'),
		[JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-should-not-appear' } }), ''].join('\n'),
	);

	const result = await mergeCodexSettings({ home, projectRoot, codexHome });
	const runtimeLayer = layerOf(result, 'runtime');
	assert.equal(runtimeLayer.exists, false);
	assert.match(runtimeLayer.note, /No runtime state observed/);
});

test('with no rollout for this project the runtime row says so and the files stand', async () => {
	const { home, projectRoot, codexHome } = fixture('norollout', { withRollout: false });
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	const runtimeLayer = layerOf(result, 'runtime');
	assert.equal(runtimeLayer.exists, false);
	assert.equal(runtimeLayer.path, null);
	assert.match(runtimeLayer.note, /No runtime state observed/);

	const model = keyOf(result, 'model');
	assert.equal(model.winningLayer, 'project');
	assert.equal(model.effectiveValue, 'gpt-from-project');
});

test('conflicts count only the layers that actually apply', async () => {
	const { home, projectRoot, codexHome } = fixture('conflicts', { withRollout: false });
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	const conflictKeys = result.conflicts.map((row) => row.key);
	// user + project both set model and both apply.
	assert.ok(conflictKeys.includes('model'));
	// user + project both set notify, but the project one is denied, so nothing
	// was overridden and there is no conflict to chase.
	assert.equal(conflictKeys.includes('notify'), false);
});

test('a malformed line does not discard the keys the parser recovered', async () => {
	const home = tmpRoot('broken-home');
	const projectRoot = tmpRoot('broken-repo');
	const codexHome = path.join(home, '.codex');
	write(
		path.join(codexHome, 'config.toml'),
		['model = "gpt-ok"', 'this line is not toml', 'service_tier = "flex"', ''].join('\n'),
	);

	const result = await mergeCodexSettings({ home, projectRoot, codexHome });
	const user = layerOf(result, 'user');
	assert.ok(user.error, 'expected the parse error to surface on the layer row');
	assert.match(user.error, /line 2/);
	assert.equal(keyOf(result, 'model').effectiveValue, 'gpt-ok');
	assert.equal(keyOf(result, 'service_tier').effectiveValue, 'flex');
});

test('a missing project config is a layer row, not a missing layer', async () => {
	const { home, projectRoot, codexHome } = fixture('noproject', { withProject: false, withRollout: false });
	const result = await mergeCodexSettings({ home, projectRoot, codexHome });

	const project = layerOf(result, 'project');
	assert.equal(project.exists, false);
	assert.equal(project.keyCount, 0);
	assert.equal(project.path, path.join(projectRoot, '.codex', 'config.toml'));
	assert.equal(keyOf(result, 'model').winningLayer, 'user');
});

test('guarded reality check: the real ~/.codex config merges without throwing', async (t) => {
	const home = os.homedir();
	const projectRoot = process.env.HARNESS_REALITY_REPO || path.join(import.meta.dirname, '..');
	const realCodexHome = process.env.CODEX_HOME || path.join(home, '.codex');
	if (!fs.existsSync(path.join(realCodexHome, 'config.toml')) || !fs.existsSync(projectRoot)) {
		t.skip('no real ~/.codex/config.toml on this machine');
		return;
	}

	const result = await mergeCodexSettings({ home, projectRoot });
	assert.ok(result.keys.length > 50, `expected > 50 keys from the real config, got ${result.keys.length}`);
	assert.ok(result.layers.length >= 4);

	const model = result.keys.find((row) => row.key === 'model');
	assert.ok(model, 'expected a model key');
	const hasRuntime = model.perLayer.some((entry) => entry.layer === 'runtime');
	assert.equal(
		model.winningLayer,
		hasRuntime ? 'runtime' : 'user',
		'model must win from the observed runtime when one exists, and from the user config otherwise',
	);

	// Nothing that looks like a live key may leave this module.
	for (const row of result.keys) {
		if (typeof row.effectiveValue !== 'string') continue;
		assert.doesNotMatch(row.effectiveValue, /\bsk-[A-Za-z0-9._-]{16,}/, `${row.key} leaked a secret-shaped value`);
	}
});
