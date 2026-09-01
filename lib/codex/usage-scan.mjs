/**
 * Frequency counters for Codex extensions that carry no counter of their
 * own on disk: MCP servers/tools and subagent dispatches. Codex counterpart
 * of `../usage-scan.mjs` — same purpose (a transcript miner, not a settings
 * reader), same consumer (`server.mjs`'s `mergeUsage()`), different source
 * format: a Codex session rollout, not a Claude Code transcript.
 *
 * Unlike Claude Code, a Codex rollout has NO record of custom-prompt
 * invocation and NO hook execution record at all (Codex confirmed,
 * 2026-08-26 — see `codex-report.md` §10). This module does not fabricate
 * either: `commands` and `hooks` are always returned empty, each with a
 * `notes[]` entry explaining why empty here means "untracked", never
 * "zero happened".
 *
 * MCP tool calls and subagent dispatches DO have a stable rollout shape —
 * `response_item.payload.type === 'function_call'` — confirmed against real
 * rollouts on this machine:
 *   - MCP:      `{ namespace: "mcp__<server-id, '-' -> '_'>", name: "<tool>" }`
 *     e.g. `{"namespace":"mcp__claude_peers","name":"set_summary"}` (server
 *     `claude-peers`, tool `set_summary`).
 *   - subagent: `{ namespace: "collaboration", name: "spawn_agent",
 *     arguments: "{\"agent_type\":\"backend-nestjs-reviewer\",...}" }` — the
 *     agent identity is inside the `arguments` JSON STRING, under
 *     `agent_type` in every real spawn seen on this machine; `agent`,
 *     `role` and `name` are also checked in case a different call site uses
 *     a different key, and a call with none of them is counted as
 *     `(default)`.
 *
 * COST: same discipline as `../usage-scan.mjs` — every rollout is streamed
 * line by line through `node:readline` over a `fs.createReadStream`, never
 * read whole into memory, and only the `limitSessions` most relevant
 * rollouts (see `selectSessionFiles`) are streamed at all. Session
 * SELECTION only reads each candidate file's first line.
 *
 * READ ONLY. No write call exists in this module.
 *
 * UNTRUSTED CONTENT: a rollout embeds tool arguments and output from every
 * project the user has open. This module treats it as data to count,
 * nothing else. Every string this module emits (a server name, a tool name,
 * a subagent type) is passed through `redactText` and capped before it
 * leaves the module.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolveCodexPaths } from './layers.mjs';
import { redactText } from '../mask.mjs';

const DEFAULT_LIMIT_SESSIONS = 50;
const MAX_EMITTED_NAME_LENGTH = 120;
/** Upper bound on how many candidate rollout files this module will PEEK
 * (read only their first line) while looking for `limitSessions` worth of
 * cwd-matching sessions — see `injected-context.mjs` for the identical
 * rationale (duplicated here rather than imported: each Codex scanner
 * degrades independently if another one breaks). */
const MIN_PEEK_CAP = 200;
const PEEK_CAP_MULTIPLIER = 20;
/** Priority order for the field inside a `spawn_agent` call's `arguments`
 * JSON that names the agent. `agent_type` is what every real spawn on this
 * machine actually uses; the rest are defensive fallbacks, never assumed. */
const SUBAGENT_TYPE_KEYS = ['agent_type', 'agent', 'role', 'name'];

/** Lists every `.jsonl` file under `sessionsDir`, newest mtime first. Never
 * throws: a missing or unreadable directory yields an empty list. */
function collectRolloutFiles(sessionsDir) {
	const out = [];
	function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
			let mtimeMs = 0;
			try {
				mtimeMs = fs.statSync(full).mtimeMs;
			} catch {
				mtimeMs = 0;
			}
			out.push({ path: full, mtimeMs });
		}
	}
	walk(sessionsDir);
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Reads and JSON-parses ONLY the first non-blank line of `filePath`. See
 * `injected-context.mjs`'s identical helper for the full rationale. */
function readFirstJsonLine(filePath) {
	return new Promise((resolve) => {
		let stream;
		try {
			stream = fs.createReadStream(filePath, { encoding: 'utf8' });
		} catch {
			resolve(null);
			return;
		}
		let settled = false;
		let rl;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			try {
				rl?.close();
			} catch {
				/* already closed */
			}
			try {
				stream.destroy();
			} catch {
				/* already destroyed */
			}
			resolve(value);
		};
		stream.on('error', () => finish(null));
		rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
		rl.on('line', (line) => {
			if (line.trim().length === 0) return;
			let event = null;
			try {
				event = JSON.parse(line);
			} catch {
				event = null;
			}
			finish(event);
		});
		rl.on('close', () => finish(null));
	});
}

async function peekCwd(filePath) {
	const event = await readFirstJsonLine(filePath);
	if (event?.type !== 'session_meta') return null;
	const cwd = event.payload?.cwd;
	return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

/** Selects up to `limitSessions` rollout files, newest first, preferring an
 * exact `session_meta.cwd` match on `projectRoot`, falling back to a cwd
 * that is a subdirectory of it, falling back to the newest rollouts
 * regardless of cwd — see `injected-context.mjs`'s identical helper for the
 * full rationale (duplicated here on purpose). */
async function selectSessionFiles({ sessionsDir, projectRoot, limitSessions }) {
	const all = collectRolloutFiles(sessionsDir);
	const prefix = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
	const peekCap = Math.max(MIN_PEEK_CAP, limitSessions * PEEK_CAP_MULTIPLIER);
	const candidates = all.slice(0, peekCap);

	const exact = [];
	const under = [];
	for (const file of candidates) {
		const cwd = await peekCwd(file.path);
		if (cwd === projectRoot) exact.push(file);
		else if (typeof cwd === 'string' && cwd.startsWith(prefix)) under.push(file);
		if (exact.length >= limitSessions) break;
	}

	if (exact.length > 0) return { files: exact.slice(0, limitSessions), fallback: false };
	if (under.length > 0) return { files: under.slice(0, limitSessions), fallback: true };
	return { files: all.slice(0, limitSessions), fallback: true };
}

/** Redacts and caps any string this module is about to emit from rollout
 * content. Non-strings become an empty string rather than risking a raw
 * value reaching the caller. */
function sanitizeEmittedName(raw) {
	if (typeof raw !== 'string' || raw.length === 0) return '';
	return redactText(raw).slice(0, MAX_EMITTED_NAME_LENGTH);
}

function bumpCount(map, key, amount = 1) {
	map.set(key, (map.get(key) || 0) + amount);
}

/** Extracts the agent identity from a `spawn_agent` call's `arguments`
 * JSON STRING. Returns `'(default)'` when the string is missing,
 * unparsable, or names none of `SUBAGENT_TYPE_KEYS` — never throws, never
 * guesses beyond that documented key list. */
function extractSubagentType(rawArguments) {
	if (typeof rawArguments !== 'string' || rawArguments.length === 0) return '(default)';
	let parsed;
	try {
		parsed = JSON.parse(rawArguments);
	} catch {
		return '(default)';
	}
	if (!parsed || typeof parsed !== 'object') return '(default)';
	for (const key of SUBAGENT_TYPE_KEYS) {
		const value = parsed[key];
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return '(default)';
}

/** Sorts by `countKey` descending, then `nameKey` ascending — mirrors
 * `../usage-scan.mjs`'s ordering exactly, so both harnesses' usage rows read
 * the same way. */
function sortByCountThenName(list, countKey, nameKey) {
	return [...list].sort((a, b) => {
		if (b[countKey] !== a[countKey]) return b[countKey] - a[countKey];
		return String(a[nameKey]).localeCompare(String(b[nameKey]));
	});
}

function buildMcpServersResult(mcpServersMap) {
	const rows = [...mcpServersMap.entries()].map(([server, entry]) => ({
		name: sanitizeEmittedName(server),
		calls: entry.calls,
		tools: sortByCountThenName(
			[...entry.tools.entries()].map(([tool, calls]) => ({ name: sanitizeEmittedName(tool), calls })),
			'calls',
			'name',
		),
	}));
	return sortByCountThenName(rows, 'calls', 'name');
}

function buildSubagentsResult(subagentsMap) {
	const rows = [...subagentsMap.entries()].map(([type, dispatches]) => ({
		type: sanitizeEmittedName(type),
		dispatches,
	}));
	return sortByCountThenName(rows, 'dispatches', 'type');
}

function processFunctionCall(payload, acc) {
	const namespace = payload.namespace;
	// An absent namespace is a built-in local tool (exec_command, wait, ...),
	// never an MCP or subagent call -- these vastly outnumber namespaced calls
	// in any real rollout, so counting them as drift candidates would flag
	// every ordinary session that simply never called an MCP tool.
	if (typeof namespace !== 'string' || namespace.length === 0) return;
	acc.stats.calls += 1;

	if (namespace.startsWith('mcp__')) {
		acc.stats.recognized += 1;
		const tool = payload.name;
		if (typeof tool !== 'string' || tool.length === 0) return;
		let entry = acc.mcpServers.get(namespace);
		if (!entry) {
			entry = { calls: 0, tools: new Map() };
			acc.mcpServers.set(namespace, entry);
		}
		entry.calls += 1;
		bumpCount(entry.tools, tool);
		return;
	}

	if (namespace === 'collaboration' && payload.name === 'spawn_agent') {
		acc.stats.recognized += 1;
		const type = extractSubagentType(payload.arguments);
		bumpCount(acc.subagents, type);
		return;
	}

	// A namespaced call that matched neither known shape -- either a
	// namespace this module has no branch for, or a collaboration action
	// other than spawn_agent. Named in the drift note only when NOTHING in
	// the window is recognized at all; on its own it is just an uncounted
	// category, not a broken scanner.
	acc.stats.unknownNamespaces.add(namespace);
}

/** Streams one rollout file, feeding every `function_call` response_item
 * into `processFunctionCall`. A malformed line, a bad individual event, an
 * unreadable file, or a stream-level error is skipped — never fatal to the
 * rest of the file or the rest of the scan. */
function scanRolloutFile(filePath, acc) {
	return new Promise((resolve) => {
		let stream;
		try {
			stream = fs.createReadStream(filePath, { encoding: 'utf8' });
		} catch {
			resolve();
			return;
		}
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		stream.on('error', finish);
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
		rl.on('line', (line) => {
			if (line.trim().length === 0) return;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event?.type !== 'response_item') return;
			const payload = event.payload;
			if (!payload || payload.type !== 'function_call') return;
			try {
				processFunctionCall(payload, acc);
			} catch {
				// one malformed/unexpected function_call must never abort the scan
			}
		});
		rl.on('error', finish);
		rl.on('close', finish);
	});
}

/**
 * @param {{home: string, projectRoot: string, limitSessions?: number}} options
 */
export async function scanUsage({ home, projectRoot, limitSessions = DEFAULT_LIMIT_SESSIONS }) {
	if (typeof home !== 'string' || home.length === 0) {
		throw new TypeError('scanUsage requires an absolute home directory');
	}
	if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
		throw new TypeError('scanUsage requires an absolute projectRoot');
	}

	const paths = resolveCodexPaths({ home, projectRoot });
	const sessionsDir = paths.user.sessionsDir;

	let error = null;
	if (!fs.existsSync(sessionsDir)) {
		error = `no Codex sessions directory found at ${sessionsDir}`;
	}

	const { files } = await selectSessionFiles({ sessionsDir, projectRoot, limitSessions });

	const acc = {
		mcpServers: new Map(),
		subagents: new Map(),
		stats: { calls: 0, recognized: 0, unknownNamespaces: new Set() },
	};
	for (const file of files) {
		// eslint-disable-next-line no-await-in-loop -- sequential on purpose: bounds
		// concurrently-open file handles and keeps scan order deterministic.
		await scanRolloutFile(file.path, acc);
	}

	const notes = [
		'commands: Codex rollouts carry no custom-prompt invocation provenance — this list is untracked, not a count of zero.',
		'hooks: Codex rollouts carry no hook execution record at all — this list is untracked, not a count of zero.',
	];
	// This scanner reads an UNDOCUMENTED function-call shape. When every
	// namespaced call in the window matched neither the MCP nor the subagent
	// shape, the honest reading is "the format may have changed", said here in
	// one line — never mcpServers/subagents that quietly render empty like
	// nothing was ever called.
	if (acc.stats.calls > 0 && acc.stats.recognized === 0) {
		notes.push(
			`Format drift: scanned ${files.length} rollout(s) and saw ${acc.stats.calls} namespaced function-call record(s), but recognized none as an MCP call or a subagent dispatch (${[...acc.stats.unknownNamespaces].slice(0, 5).join(', ') || 'untyped'}). The Codex rollout function-call format may have changed since this panel was written — mcpServers/subagents below may be missing real calls, not reporting their absence.`,
		);
	}

	return {
		mcpServers: buildMcpServersResult(acc.mcpServers),
		commands: [],
		subagents: buildSubagentsResult(acc.subagents),
		hooks: [],
		// Which dimensions this harness CANNOT count, so the merge never turns an
		// absent record into a confident zero. A rollout keeps no custom-prompt
		// provenance and no hook execution record at all, and an MCP call routed
		// through the `exec` aggregator is not attributable to its server -- so a
		// server with no direct `mcp__*` call is "not observed", not "never used".
		untracked: ['commands', 'hooks'],
		partial: ['mcpServers'],
		notes,
		scanned: {
			sessions: files.length,
			files: files.length,
			limitSessions,
		},
		error,
	};
}
