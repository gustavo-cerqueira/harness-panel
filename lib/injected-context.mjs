/**
 * What actually gets injected into a Claude Code session — reported honestly,
 * layer by layer, each labelled with its real source.
 *
 * The base system prompt is harness-internal: it is not written to disk
 * anywhere this panel can read, so this module NEVER fabricates or
 * reconstructs it. What IS readable is the output every hook already left
 * behind in the session transcript, because Claude Code records hook stdout
 * as `attachment` lines while the session runs. This module reads those
 * transcripts — it never re-executes a hook, which would break the panel's
 * read-only guarantee and could run an arbitrary user script.
 *
 * Transcripts live at `<home>/.claude/projects/<sanitized-cwd>/*.jsonl`, one
 * JSON object per line, newest activity appended at the end of each file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSourceFile, vscodeLink } from './source-file.mjs';
import { resolveLayerPaths } from './layers.mjs';
import { redactText } from './mask.mjs';
import { scanPlugins } from './plugins-scan.mjs';

/** Attachment `type` values this module recognises as hook output worth
 * surfacing. Exported so the UI can explain what each one is. */
export const HOOK_ATTACHMENT_TYPES = Object.freeze([
	'hook_success', // a hook ran and returned stdout/output
	'hook_additional_context', // a hook injected extra context into the transcript
	'hook_system_message', // a hook surfaced a system-facing message
]);

const CAPTURE_CHAR_CAP = 8000;
const DEFAULT_LIMIT_SESSIONS = 20;

/** The sanitized directory name Claude Code uses for a cwd: '/' and '.' both
 * become '-' (e.g. /Users/me/.claude -> -Users-me--claude). */
function sanitizeCwd(cwd) {
	return cwd.replace(/[/.]/g, '-');
}

/** Lists `.jsonl` files directly under `dir`, newest mtime first. Never
 * throws: a missing or unreadable directory yields an empty list. */
function listJsonlFiles(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
		.map((entry) => {
			const full = path.join(dir, entry.name);
			let mtimeMs = 0;
			try {
				mtimeMs = fs.statSync(full).mtimeMs;
			} catch {
				mtimeMs = 0;
			}
			return { path: full, mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function isDirectory(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * True when `dirent` is a directory, OR a symlink whose target resolves to
 * one. `readdirSync(..., { withFileTypes: true })` never follows symlinks
 * for `Dirent.isDirectory()`, so a symlinked project transcript directory
 * (e.g. a worktree's `.claude/projects/<sanitized>` symlinked back to the
 * main checkout's) would otherwise be silently dropped from the fallback
 * scan. A broken symlink is treated as not-a-directory, never thrown.
 */
function isEffectivelyDirectory(dirent, parentDir) {
	if (dirent.isDirectory()) return true;
	if (!dirent.isSymbolicLink()) return false;
	try {
		return fs.statSync(path.join(parentDir, dirent.name)).isDirectory();
	} catch {
		return false;
	}
}

/** A hook attachment's captured text may arrive as a plain string (most hook
 * types) or as an array of strings (`hook_additional_context` in current
 * transcripts). Anything else has nothing readable to show. */
function extractRawText(attachment) {
	const raw = attachment.content ?? attachment.text ?? attachment.stdout ?? null;
	if (typeof raw === 'string') return raw;
	if (Array.isArray(raw)) {
		const strings = raw.filter((entry) => typeof entry === 'string');
		return strings.length > 0 ? strings.join('\n\n') : null;
	}
	return null;
}

/**
 * Builds one capture record from a recognised hook attachment, or null when
 * the attachment carried no readable text. `bytes` reports the size of the
 * ORIGINAL captured text (before the 8000-char cap), so a truncated entry
 * still tells the reader how large the real injection actually was.
 */
function buildCapture({ attachment, transcriptPath, capturedAt }) {
	const rawText = extractRawText(attachment);
	if (rawText == null) return null;

	const bytes = Buffer.byteLength(rawText, 'utf8');
	const truncated = rawText.length > CAPTURE_CHAR_CAP;
	const clipped = truncated ? rawText.slice(0, CAPTURE_CHAR_CAP) : rawText;

	return {
		hookName: attachment.hookName ?? null,
		hookEvent: attachment.hookEvent ?? null,
		source: 'transcript',
		transcriptPath,
		capturedAt,
		durationMs: typeof attachment.durationMs === 'number' ? attachment.durationMs : null,
		text: redactText(clipped),
		truncated,
		bytes,
	};
}

/**
 * Reads one transcript file and appends any SessionStart / UserPromptSubmit
 * hook output it finds into the caller's accumulators. Parses defensively:
 * an unreadable file or a malformed JSONL line is skipped, never fatal.
 */
function collectFromTranscript(transcriptPath, sessionStartOutput, userPromptSubmitOutput, stats) {
	let raw;
	try {
		raw = fs.readFileSync(transcriptPath, 'utf8');
	} catch {
		return;
	}

	for (const line of raw.split('\n')) {
		if (line.trim().length === 0) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue; // malformed line — skip, never fatal to the rest of the file
		}
		const attachment = event?.attachment;
		if (!attachment) continue;
		stats.attachments += 1;
		if (!HOOK_ATTACHMENT_TYPES.includes(attachment.type)) {
			// An attachment type this module has never seen. One unknown among
			// recognized ones is a new feature; ONLY unknowns is format drift,
			// and the caller says so out loud instead of rendering emptiness.
			if (typeof attachment.type === 'string') stats.unknownTypes.add(attachment.type);
			continue;
		}
		stats.recognized += 1;

		const capture = buildCapture({
			attachment,
			transcriptPath,
			capturedAt: typeof event.timestamp === 'string' ? event.timestamp : null,
		});
		if (!capture) continue;

		if (attachment.hookEvent === 'SessionStart') sessionStartOutput.push(capture);
		else if (attachment.hookEvent === 'UserPromptSubmit') userPromptSubmitOutput.push(capture);
	}
}

/**
 * Reads the `outputStyle` setting through the cascade (weakest layer first,
 * later wins — the same rule `lib/layers.mjs` documents for everything else)
 * and resolves the winning NAME to a real file. A style is not only ever
 * user-owned: it can also ship inside an installed plugin, so the search
 * checks every place a style file can actually live, first hit wins, in
 * this documented order:
 *
 *   1. `<home>/.claude/output-styles/<name>.md`               (user)
 *   2. `<projectRoot>/.claude/output-styles/<name>.md`         (project)
 *   3. `<pluginPath>/output-styles/<name>.md` for every plugin (plugin cache)
 *      the settings cascade currently reports as ENABLED, in the same
 *      order `scanPlugins()` (lib/plugins-scan.mjs) reports them. A
 *      disabled plugin's copy is never considered a hit.
 *
 * 'absent' (`exists: false`) is reported only when none of those locations
 * holds the file — never merely because the user-layer copy is missing.
 */
function scanOutputStyle(paths, { home, projectRoot }) {
	const cascadeFiles = [
		paths.user.settings,
		paths.project.settings,
		paths.local.settings,
		paths.enterprise.managedSettings,
	];

	let name = null;
	for (const settingsPath of cascadeFiles) {
		const file = readSourceFile(settingsPath);
		if (!file.readable) continue;
		try {
			const json = JSON.parse(file.content);
			if (typeof json.outputStyle === 'string' && json.outputStyle.length > 0) {
				name = json.outputStyle;
			}
		} catch {
			// malformed settings file — not this module's problem to report, skip
		}
	}

	if (!name) {
		return { exists: false, name: null, path: null, line: null, link: null, content: null };
	}

	const candidatePaths = [
		path.join(paths.user.outputStylesDir, `${name}.md`),
		path.join(paths.project.dir, 'output-styles', `${name}.md`),
	];
	try {
		const { plugins } = scanPlugins({ home, projectRoot });
		for (const plugin of plugins) {
			if (plugin.enabled) candidatePaths.push(path.join(plugin.path, 'output-styles', `${name}.md`));
		}
	} catch {
		// plugin cache unreadable or malformed — fall through with the
		// user/project candidates already collected, never fatal here.
	}

	for (const stylePath of candidatePaths) {
		const file = readSourceFile(stylePath);
		if (!file.readable) continue;
		return {
			name,
			path: stylePath,
			line: 1,
			link: vscodeLink(stylePath, 1),
			exists: true,
			content: file.content,
		};
	}

	return { name, path: null, line: null, link: null, exists: false, content: null };
}

/**
 * @param {{home: string, projectRoot: string, limitSessions?: number}} options
 */
export function scanInjectedContext({ home, projectRoot, limitSessions = DEFAULT_LIMIT_SESSIONS }) {
	if (typeof home !== 'string' || home.length === 0) {
		throw new TypeError('scanInjectedContext requires an absolute home directory');
	}
	if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
		throw new TypeError('scanInjectedContext requires an absolute projectRoot');
	}

	const paths = resolveLayerPaths({ home, projectRoot });
	const transcriptsRoot = paths.user.transcriptsDir;
	const exactDir = path.join(transcriptsRoot, sanitizeCwd(projectRoot));

	let scanDir;
	let fallback;
	let files;
	if (isDirectory(exactDir)) {
		scanDir = exactDir;
		fallback = false;
		files = listJsonlFiles(exactDir);
	} else {
		// The exact per-project transcript directory is absent (never opened
		// from this projectRoot, or this is a brand new worktree). Fall back to
		// scanning every project directory Claude Code knows about, combined and
		// sorted by recency, rather than reporting nothing.
		scanDir = transcriptsRoot;
		fallback = true;
		let projectDirs = [];
		try {
			projectDirs = fs
				.readdirSync(transcriptsRoot, { withFileTypes: true })
				.filter((entry) => isEffectivelyDirectory(entry, transcriptsRoot))
				.map((entry) => path.join(transcriptsRoot, entry.name));
		} catch {
			projectDirs = [];
		}
		files = projectDirs.flatMap((dir) => listJsonlFiles(dir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
	}

	const selected = files.slice(0, limitSessions);

	const sessionStartOutput = [];
	const userPromptSubmitOutput = [];
	const stats = { attachments: 0, recognized: 0, unknownTypes: new Set() };
	for (const { path: transcriptPath } of selected) {
		collectFromTranscript(transcriptPath, sessionStartOutput, userPromptSubmitOutput, stats);
	}

	const notes = [
		'Base Claude Code system prompt: not exposed by the harness — internal to Claude Code and not readable from disk, so it is not listed here.',
	];
	// This scanner reads an UNDOCUMENTED transcript format. When every
	// attachment in the window is of a type this module does not know, the
	// honest reading is "the format may have changed", said here in one line —
	// never an empty section that looks like "no hooks ran".
	if (stats.attachments > 0 && stats.recognized === 0) {
		notes.push(
			`Format drift: scanned ${selected.length} transcript(s) and saw ${stats.attachments} attachment line(s), but recognized none of their types (${[...stats.unknownTypes].slice(0, 5).join(', ') || 'untyped'}). The Claude Code transcript format may have changed since this panel was written — the sections below may be missing real hook output, not reporting its absence.`,
		);
	}

	return {
		baseSystemPrompt: {
			available: false,
			reason: 'Not exposed by the harness — internal to Claude Code and not readable from disk.',
		},
		// A fact with no row behind it belongs in a note: as a row it read as a
		// permanently broken entry rather than a stated limit.
		notes,
		outputStyle: scanOutputStyle(paths, { home, projectRoot }),
		sessionStartOutput,
		userPromptSubmitOutput,
		scanned: {
			directory: scanDir,
			files: selected.length,
			oldest: selected.length > 0 ? new Date(selected[selected.length - 1].mtimeMs).toISOString() : null,
			newest: selected.length > 0 ? new Date(selected[0].mtimeMs).toISOString() : null,
			fallback,
		},
	};
}
