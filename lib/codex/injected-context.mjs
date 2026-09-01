/**
 * What actually gets injected into a Codex CLI session — reported honestly,
 * reconstructed from what the session rollout already recorded.
 *
 * Codex has no hook-attachment concept the way Claude Code does: a rollout
 * carries NO stable "a hook ran and printed this" record (Codex confirmed,
 * 2026-08-26 — see `codex-report.md` §10). What a rollout DOES carry is every
 * artifact a session actually consumed, each under its own record type:
 *
 *   - `session_meta.payload.base_instructions`  — the base model instructions,
 *     recorded verbatim (not reconstructed — this module never guesses it).
 *   - the latest `turn_context`                 — the effective runtime state
 *     (model, effort, approval policy, sandbox, permission profile) for the
 *     most recent turn this module scanned.
 *   - `world_state.payload.state.agents_md`      — the combined AGENTS.md
 *     chain Codex actually assembled and injected.
 *   - `world_state.payload.state.skills` /
 *     `world_state.payload.state.plugins_instructions` — whether the skills
 *     catalog and plugin instructions were included in this session.
 *   - developer-role `response_item` messages    — the injected catalogs
 *     (`<skills_instructions>`, `<permissions instructions>`, …) AND whatever
 *     a SessionStart-style hook additionally injected (e.g. "# Basic Memory —
 *     session context"). Nothing in the rollout tags WHICH of these came from
 *     a hook versus a built-in catalog — attribution here is by matching the
 *     first heading/line of the message, never a stable ID.
 *   - user-role `response_item` messages         — the AGENTS.md chain in its
 *     older single-block form ("# AGENTS.md instructions for <cwd>") and the
 *     `<environment_context>` block Codex prepends to a turn.
 *
 * So this module returns the SAME top-level shape as
 * `../injected-context.mjs` (`baseSystemPrompt`, `outputStyle`,
 * `sessionStartOutput`, `userPromptSubmitOutput`, `scanned`) so
 * `public/app.js`'s `injected` adapter renders it unchanged, but every field
 * is filled from rollout content rather than a transcript attachment.
 * `outputStyle` has no Codex equivalent, so it is repurposed to carry the
 * latest turn_context — Codex's closest thing to "the effective runtime
 * configuration" — under the SAME field names the adapter already reads
 * (`name`, `exists`, `path`, `line`, `link`, `content`), plus `settings` for
 * anything that wants the parsed object instead of its JSON string.
 *
 * COST: a rollout can run past 40k lines. Every file this module reads is
 * streamed line by line through `node:readline` over a
 * `fs.createReadStream` — never `fs.readFileSync`'d whole — and only the
 * `limitSessions` most relevant rollouts (see `selectSessionFiles` below) are
 * streamed at all. Session SELECTION itself only reads each candidate
 * file's first line (its `session_meta`), never the whole file.
 *
 * READ ONLY. No write call exists in this module.
 *
 * UNTRUSTED CONTENT: a rollout embeds raw prompt/tool/file content from
 * every project the user has open, so any string this module surfaces is
 * treated as untrusted data, never as instructions. Every captured text is
 * passed through `redactText` and capped at 600 characters before it leaves
 * this module.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolveCodexPaths } from './layers.mjs';
import { redactText } from '../mask.mjs';
import { vscodeLink } from '../source-file.mjs';

const DEFAULT_LIMIT_SESSIONS = 20;
/** Top-level rollout record `type` values this module has switch-case logic
 * for. Exported nowhere on purpose — unlike Claude Code's HOOK_ATTACHMENT_TYPES,
 * nothing outside this module needs to explain what these mean. Every real
 * rollout starts with a `session_meta` line, so a scanned window where NOT ONE
 * record matches this list is a strong drift signal, not a coincidence of an
 * ordinary session. */
const KNOWN_ROLLOUT_RECORD_TYPES = ['session_meta', 'turn_context', 'world_state', 'response_item'];
/** How much of any one captured text block is kept. Rollout text blocks run
 * to tens of KB (a `<skills_instructions>` catalog alone can be 20+ KB), so
 * this cap is far tighter than Claude's 8000-char transcript cap. */
const CAPTURE_CHAR_CAP = 600;
/** A derived hookName (the first line of a developer/user message) is capped
 * separately from the body text — a minified or heading-less block should
 * never turn into an unreadable multi-hundred-character row title. */
const MAX_HOOK_NAME_LENGTH = 120;
/** Upper bound on how many candidate rollout files this module will PEEK
 * (read only their first line) while looking for `limitSessions` worth of
 * cwd-matching sessions. Bounds worst-case latency when nothing on disk
 * matches `projectRoot` at all, rather than peeking every rollout the user
 * has ever run across every project. */
const MIN_PEEK_CAP = 200;
const PEEK_CAP_MULTIPLIER = 20;

/** Lists every `.jsonl` file under `sessionsDir` (Codex nests them
 * `YYYY/MM/DD/rollout-*.jsonl`, but this walks arbitrarily deep so a layout
 * change never silently drops files), newest mtime first. Never throws: a
 * missing or unreadable directory yields an empty list. */
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

/** Reads and JSON-parses ONLY the first non-blank line of `filePath`, then
 * stops reading — this is how session selection can peek a rollout's
 * `session_meta` without paying to stream a 40k-line file. Resolves `null`
 * on any error or if the file has no readable first line. */
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
			if (line.trim().length === 0) return; // keep waiting for the first real line
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

/** The `cwd` a rollout's `session_meta` recorded, or `null` when the first
 * line was not a readable `session_meta`. */
async function peekCwd(filePath) {
	const event = await readFirstJsonLine(filePath);
	if (event?.type !== 'session_meta') return null;
	const cwd = event.payload?.cwd;
	return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

/**
 * Selects up to `limitSessions` rollout files, newest first, in three
 * honesty tiers:
 *   1. `exact`  — `session_meta.cwd === projectRoot`.
 *   2. `under`  — `session_meta.cwd` is a subdirectory of `projectRoot`
 *                 (e.g. scanning `<repo>` also picks up a session opened in
 *                 `<repo>/projects/ez_backend`).
 *   3. `any`    — no cwd match at all anywhere peeked; the newest rollouts
 *                 are returned regardless, rather than reporting nothing.
 * Whichever tier actually supplied the files is returned as `cwdMatch`, so a
 * caller never mistakes tier-3 fallback data for a real match.
 */
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
		if (exact.length >= limitSessions) break; // newest-first, so these are already the best exact matches
	}

	if (exact.length > 0) return { files: exact.slice(0, limitSessions), cwdMatch: 'exact' };
	if (under.length > 0) return { files: under.slice(0, limitSessions), cwdMatch: 'under' };
	return { files: all.slice(0, limitSessions), cwdMatch: 'any' };
}

/** Streams one rollout file line by line, calling `onEvent` for every
 * successfully-parsed record. A malformed line, a bad individual event, an
 * unreadable file, or a stream-level error is skipped — never fatal to the
 * rest of the file or the rest of the scan. */
function streamRolloutFile(filePath, onEvent) {
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
			try {
				onEvent(event);
			} catch {
				// one malformed/unexpected event must never abort the whole scan
			}
		});
		rl.on('error', finish);
		rl.on('close', finish);
	});
}

/** A `message` response_item's `content` is either a plain string or an
 * array of `{type, text}` blocks — and CRUCIALLY, one message can bundle
 * several unrelated injected artifacts as separate blocks (a real first user
 * turn was seen carrying `<recommended_plugins>`, the AGENTS.md chain, AND
 * `<environment_context>` as three distinct blocks). So this returns each
 * block's text SEPARATELY — never joined — so each can be attributed to its
 * own artifact by its own heading. */
function extractTextBlocks(content) {
	if (typeof content === 'string') return content.length > 0 ? [content] : [];
	if (Array.isArray(content)) {
		return content
			.filter((item) => item && typeof item.text === 'string' && item.text.length > 0)
			.map((item) => item.text);
	}
	return [];
}

/** Redacts and caps a block of captured text. `bytes` reports the size of
 * the ORIGINAL text (before the 600-char cap), so a truncated capture still
 * says how large the real injected artifact was. */
function clipAndRedact(rawText) {
	const bytes = Buffer.byteLength(rawText, 'utf8');
	const truncated = rawText.length > CAPTURE_CHAR_CAP;
	const clipped = truncated ? rawText.slice(0, CAPTURE_CHAR_CAP) : rawText;
	return { text: redactText(clipped), bytes, truncated };
}

function firstHeadingLine(rawText) {
	const line = rawText.trimStart().split('\n', 1)[0] ?? '';
	return redactText(line).slice(0, MAX_HOOK_NAME_LENGTH) || '(empty)';
}

/** Counts `<skills_instructions>` catalog entries. Each skill is rendered as
 * one `- name: description (file: rN/...)` line — a bullet with a colon
 * right after its first word — which excludes the "### Skill roots" bullets
 * above it (those use `- \`rN\` = \`/abs/path\`` and have no colon-led lead
 * word), so this only ever counts real skill rows. */
function countSkillEntries(rawText) {
	const matches = rawText.match(/^- [^\n:]+:\s/gm);
	return matches ? matches.length : 0;
}

function buildNamedCapture({ hookName, rawText, transcriptPath, capturedAt }) {
	const { text, bytes, truncated } = clipAndRedact(rawText);
	return {
		hookName,
		// Rollouts record no hook provenance (Codex confirmed): these are messages
		// the CLI injected, attributed by content, never claimed as hook output.
		provenance: 'rollout message — attributed by content, no hook provenance',
		text,
		bytes,
		capturedAt: capturedAt ?? null,
		transcriptPath,
		truncated,
		durationMs: null,
	};
}

function buildDeveloperCapture({ rawText, transcriptPath, capturedAt }) {
	const capture = buildNamedCapture({ hookName: firstHeadingLine(rawText), rawText, transcriptPath, capturedAt });
	if (rawText.trimStart().startsWith('<skills_instructions>')) {
		capture.skillCount = countSkillEntries(rawText);
	}
	return capture;
}

function buildAgentsMdCapture({ directory, text, transcriptPath, timestamp }) {
	const capture = buildNamedCapture({
		hookName: 'AGENTS.md chain (world_state)',
		rawText: text,
		transcriptPath,
		capturedAt: timestamp,
	});
	capture.directory = directory ?? null;
	return capture;
}

function buildCatalogFlagsCapture({ skills, pluginsInstructions, transcriptPath, timestamp }) {
	const rawText = JSON.stringify({ skills: skills ?? null, pluginsInstructions: pluginsInstructions ?? null });
	return buildNamedCapture({ hookName: 'catalog flags', rawText, transcriptPath, capturedAt: timestamp });
}

function buildBaseSystemPrompt({ rawText, transcriptPath, capturedAt }) {
	const { text, bytes } = clipAndRedact(rawText);
	return {
		available: true,
		reason:
			'recorded base instructions (session_meta.base_instructions) — not the complete hidden system prompt: the CLI adds developer messages, tool schemas and permission context at runtime',
		complete: false,
		transcriptPath,
		bytes,
		capturedAt: capturedAt ?? null,
		textHead: text,
	};
}

/** The base_instructions field on `session_meta.payload` has been observed
 * both as a plain string and as an object carrying `{text, provenance}` —
 * only `text` is ever read; `provenance` and any other sibling key are
 * ignored, never surfaced. */
function extractBaseInstructionsText(baseInstructions) {
	if (typeof baseInstructions === 'string') return baseInstructions.length > 0 ? baseInstructions : null;
	if (baseInstructions && typeof baseInstructions === 'object' && typeof baseInstructions.text === 'string') {
		return baseInstructions.text.length > 0 ? baseInstructions.text : null;
	}
	return null;
}

/**
 * Builds the `outputStyle` row from the latest `turn_context` this module
 * scanned. `collaboration_mode` is narrowed to its `.mode` string — the
 * whole object also carries a nested `settings` block (model/effort/
 * developer_instructions), which would duplicate the sibling `model` and
 * `effort` fields already reported here.
 */
function buildOutputStyle(latest) {
	if (!latest) {
		return {
			name: 'turn context (effective runtime)',
			exists: false,
			path: null,
			line: null,
			link: null,
			content: null,
			settings: null,
		};
	}
	const p = latest.payload ?? {};
	const settings = {
		model: p.model ?? null,
		effort: p.effort ?? null,
		approval_policy: p.approval_policy ?? null,
		sandbox_policy: p.sandbox_policy ?? null,
		permission_profile: p.permission_profile ?? null,
		collaboration_mode: p.collaboration_mode?.mode ?? null,
		personality: p.personality ?? null,
		service_tier: p.service_tier ?? null,
	};
	return {
		name: 'turn context (effective runtime)',
		exists: true,
		path: latest.transcriptPath,
		line: 1,
		link: vscodeLink(latest.transcriptPath, 1),
		content: JSON.stringify(settings),
		settings,
	};
}

/**
 * @param {{home: string, projectRoot: string, limitSessions?: number}} options
 */
export async function scanCodexInjectedContext({ home, projectRoot, limitSessions = DEFAULT_LIMIT_SESSIONS }) {
	if (typeof home !== 'string' || home.length === 0) {
		throw new TypeError('scanCodexInjectedContext requires an absolute home directory');
	}
	if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
		throw new TypeError('scanCodexInjectedContext requires an absolute projectRoot');
	}

	const paths = resolveCodexPaths({ home, projectRoot });
	const { files, cwdMatch } = await selectSessionFiles({
		sessionsDir: paths.user.sessionsDir,
		projectRoot,
		limitSessions,
	});

	let baseSystemPrompt = {
		available: false,
		reason: 'no session rollout for this project recorded base_instructions',
	};
	let latestTurnContext = null; // { timestamp, payload, transcriptPath }
	let latestAgentsMd = null; // { timestamp, directory, text, transcriptPath }
	let latestCatalogFlags = null; // { timestamp, skills, pluginsInstructions, transcriptPath }
	const sessionStartOutput = [];
	const userPromptSubmitOutput = [];
	const stats = { records: 0, recognized: 0, unknownTypes: new Set() };

	for (const file of files) {
		// eslint-disable-next-line no-await-in-loop -- sequential on purpose: bounds
		// concurrently-open file handles and keeps the newest-session-wins
		// comparisons above deterministic.
		await streamRolloutFile(file.path, (event) => {
			stats.records += 1;
			if (KNOWN_ROLLOUT_RECORD_TYPES.includes(event.type)) stats.recognized += 1;
			// An unrecognized record among recognized ones is a new/rare record kind;
			// ONLY unrecognized across the whole window is format drift, and the
			// caller says so out loud instead of rendering empty sections.
			else if (typeof event.type === 'string') stats.unknownTypes.add(event.type);

			if (event.type === 'session_meta') {
				if (!baseSystemPrompt.available) {
					const rawText = extractBaseInstructionsText(event.payload?.base_instructions);
					if (rawText) {
						baseSystemPrompt = buildBaseSystemPrompt({
							rawText,
							transcriptPath: file.path,
							capturedAt: event.timestamp ?? null,
						});
					}
				}
				return;
			}

			if (event.type === 'turn_context') {
				if (!latestTurnContext || (event.timestamp && event.timestamp > (latestTurnContext.timestamp ?? ''))) {
					latestTurnContext = { timestamp: event.timestamp ?? null, payload: event.payload, transcriptPath: file.path };
				}
				return;
			}

			if (event.type === 'world_state') {
				const state = event.payload?.state;
				if (state && typeof state.agents_md?.text === 'string' && state.agents_md.text.length > 0) {
					if (!latestAgentsMd || (event.timestamp && event.timestamp > (latestAgentsMd.timestamp ?? ''))) {
						latestAgentsMd = {
							timestamp: event.timestamp ?? null,
							directory: state.agents_md.directory ?? null,
							text: state.agents_md.text,
							transcriptPath: file.path,
						};
					}
				}
				if (state && ('skills' in state || 'plugins_instructions' in state)) {
					if (!latestCatalogFlags || (event.timestamp && event.timestamp > (latestCatalogFlags.timestamp ?? ''))) {
						latestCatalogFlags = {
							timestamp: event.timestamp ?? null,
							skills: state.skills ?? null,
							pluginsInstructions: state.plugins_instructions ?? null,
							transcriptPath: file.path,
						};
					}
				}
				return;
			}

			if (event.type !== 'response_item') return;
			const p = event.payload;
			if (!p || p.type !== 'message') return;

			if (p.role === 'developer') {
				for (const block of extractTextBlocks(p.content)) {
					sessionStartOutput.push(
						buildDeveloperCapture({ rawText: block, transcriptPath: file.path, capturedAt: event.timestamp ?? null }),
					);
				}
				return;
			}

			if (p.role === 'user') {
				for (const block of extractTextBlocks(p.content)) {
					const trimmed = block.trimStart();
					if (trimmed.startsWith('# AGENTS.md instructions for')) {
						sessionStartOutput.push(
							buildNamedCapture({
								hookName: 'AGENTS.md instructions (user message)',
								rawText: block,
								transcriptPath: file.path,
								capturedAt: event.timestamp ?? null,
							}),
						);
					} else if (trimmed.startsWith('<environment_context>')) {
						userPromptSubmitOutput.push(
							buildNamedCapture({
								hookName: 'environment context (user message)',
								rawText: block,
								transcriptPath: file.path,
								capturedAt: event.timestamp ?? null,
							}),
						);
					}
				}
			}
		});
	}

	// world_state fires several times per session as context refreshes; only
	// the LATEST agents_md / catalog-flags snapshot is reported (mirroring
	// outputStyle's "latest turn_context" treatment) rather than one
	// near-duplicate 40KB AGENTS.md blob per session scanned.
	const prefixRows = [];
	if (latestAgentsMd) prefixRows.push(buildAgentsMdCapture(latestAgentsMd));
	if (latestCatalogFlags) prefixRows.push(buildCatalogFlagsCapture(latestCatalogFlags));
	sessionStartOutput.unshift(...prefixRows);

	userPromptSubmitOutput.sort((a, b) => String(b.capturedAt ?? '').localeCompare(String(a.capturedAt ?? '')));

	const notes = [];
	// This scanner reads an UNDOCUMENTED rollout format. When every record in
	// the scanned window is of a type this module has never seen, the honest
	// reading is "the format may have changed", said here in one line — never
	// an empty section that looks like "nothing was injected".
	if (stats.records > 0 && stats.recognized === 0) {
		notes.push(
			`Format drift: scanned ${files.length} rollout(s) and saw ${stats.records} record(s), but recognized none of their types (${[...stats.unknownTypes].slice(0, 5).join(', ') || 'untyped'}). The Codex CLI rollout format may have changed since this panel was written — the sections below may be missing real injected context, not reporting its absence.`,
		);
	}

	return {
		baseSystemPrompt,
		notes,
		outputStyle: buildOutputStyle(latestTurnContext),
		sessionStartOutput,
		userPromptSubmitOutput: userPromptSubmitOutput.slice(0, 10),
		scanned: {
			sessions: files.length,
			files: files.length,
			limitSessions,
			cwdMatch,
		},
	};
}
