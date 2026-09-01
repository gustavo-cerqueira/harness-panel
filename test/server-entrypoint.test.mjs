/**
 * `node server.mjs` must actually serve — including when the path it was
 * launched through is a symlink.
 *
 * The module only listens when it decides it was invoked directly, and that
 * decision compared `process.argv[1]` against its own module URL as plain
 * strings. Node resolves a module URL to the REAL path while argv keeps the
 * path the caller typed, so on macOS — where `/tmp` and `/var` are symlinks
 * into `/private` — the two never matched and the process loaded the whole
 * server, listened to nothing, and exited 0 without a word. A launcher that
 * resolves its own directory (`bin/start.sh`) hit this every time.
 *
 * The failure mode is the reason this test spawns a real process instead of
 * importing: nothing is observable from inside the module.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_DIR = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const SERVER = path.join(PANEL_DIR, 'server.mjs');

/** Boots the server through `entryPath` and resolves once it answers, or fails. */
async function boots(entryPath) {
	const port = 4600 + Math.floor(Math.random() * 300);
	const child = spawn(process.execPath, [entryPath], {
		env: { ...process.env, HARNESS_PORT: String(port), HARNESS_REPO: os.tmpdir() },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let exited = false;
	child.on('exit', () => {
		exited = true;
	});
	try {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			if (exited) return { ok: false, reason: 'process exited without listening' };
			try {
				const response = await fetch(`http://127.0.0.1:${port}/api/state`);
				if (response.ok) {
					await response.arrayBuffer();
					return { ok: true };
				}
			} catch {
				// not up yet
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return { ok: false, reason: 'timed out' };
	} finally {
		child.kill('SIGKILL');
	}
}

test('serves when launched by its real path', async () => {
	const result = await boots(SERVER);
	assert.equal(result.ok, true, result.reason);
});

test('serves when launched through a symlinked directory', async () => {
	// os.tmpdir() is itself symlinked on macOS, which is exactly the shape that
	// broke it; on a platform where it is not, the link created here still is.
	const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-entry-'));
	const link = path.join(linkDir, 'panel');
	fs.symlinkSync(PANEL_DIR, link, 'dir');
	const result = await boots(path.join(link, 'server.mjs'));
	assert.equal(result.ok, true, result.reason);
});
