/**
 * Workspace curation: the facts only a human who works in THIS repo can state.
 *
 * Two of the panel's answers cannot be derived from disk. Which operational
 * cluster a home-grown skill belongs to is a judgement, and whether a guard has
 * a known hole is a finding somebody verified by hand. Both used to be arrays
 * inside the panel's own source, which made the tool a record of one workspace:
 * anywhere else the bypass table rendered empty, and empty reads as "audited and
 * clean" when it means "nobody ever looked".
 *
 * So the mechanism ships and the data does not. Curation lives with the repo it
 * describes, at `.claude/harness-curation.json`, and the panel reads it if it is
 * there. A workspace without one is told so in as many words.
 *
 * READ ONLY, and hostile-input tolerant: this is a hand-edited file. A malformed
 * entry is dropped with a warning the UI can show; nothing here ever throws, and
 * nothing invalid is ever passed through as if it were curated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isKnownCluster } from './taxonomy.mjs';

/** Where a workspace declares its curation, relative to the repo root. */
export const CURATION_RELATIVE_PATH = '.claude/harness-curation.json';

/** The kinds a cluster override may target — the same set `taxonomy.mjs` clusters. */
const OVERRIDE_KINDS = ['skills', 'commands', 'agents', 'mcp'];

const emptyClusters = () => ({ skills: {}, commands: {}, agents: {}, mcp: {} });

/**
 * One curated bypass. `match` is optional: a hole that belongs to no single
 * scanned row (a git-level gate, the intent layer as a whole) is `standalone`
 * and matches nothing on purpose.
 */
function readBypass(entry, index, warnings) {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
		warnings.push(`bypasses[${index}] is not an object and was dropped.`);
		return null;
	}
	const { guard, text, verified, match, standalone } = entry;
	if (typeof guard !== 'string' || !guard.trim() || typeof text !== 'string' || !text.trim()) {
		warnings.push(`bypasses[${index}] needs both "guard" and "text" and was dropped.`);
		return null;
	}
	if (match !== undefined) {
		if (typeof match !== 'string') {
			warnings.push(`bypasses[${index}] ("${guard}") has a non-string "match" and was dropped.`);
			return null;
		}
		try {
			new RegExp(match);
		} catch (error) {
			warnings.push(`bypasses[${index}] ("${guard}") has an invalid "match" regex and was dropped: ${error.message}`);
			return null;
		}
	}
	return {
		guard,
		text,
		// An undated finding is still a finding; saying so beats inventing a date.
		verified: typeof verified === 'string' && verified.trim() ? verified : 'undated',
		match: typeof match === 'string' ? match : null,
		standalone: standalone === true || match === undefined,
	};
}

function readClusterOverrides(raw, warnings) {
	const out = emptyClusters();
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	for (const kind of OVERRIDE_KINDS) {
		const map = raw[kind];
		if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
		for (const [name, cluster] of Object.entries(map)) {
			// An unknown cluster id would stamp a row with a label the UI cannot
			// render and an order it cannot sort by — dropped, and said out loud.
			if (typeof cluster !== 'string' || !isKnownCluster(cluster)) {
				warnings.push(`clusters.${kind}."${name}" -> "${cluster}" is not a known cluster and was dropped.`);
				continue;
			}
			out[kind][name] = cluster;
		}
	}
	return out;
}

/**
 * Reads one workspace's curation file.
 *
 * @param {{projectRoot: string}} options
 * @returns {{path: string, exists: boolean, error: string|null, warnings: string[],
 *   bypasses: object[], clusters: {skills: object, commands: object, agents: object, mcp: object}}}
 */
export function readCuration({ projectRoot } = {}) {
	if (typeof projectRoot !== 'string' || !projectRoot) {
		throw new TypeError('readCuration requires an absolute projectRoot');
	}
	const file = path.join(projectRoot, CURATION_RELATIVE_PATH);
	const empty = { path: file, exists: false, error: null, warnings: [], bypasses: [], clusters: emptyClusters() };

	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (error) {
		// ENOENT is the normal case — most workspaces curate nothing — and is
		// reported as absence. Anything else is a real read failure worth saying.
		if (error?.code === 'ENOENT') return empty;
		return { ...empty, exists: true, error: String(error?.message || error) };
	}

	let json;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return { ...empty, exists: true, error: `not valid JSON: ${error.message}` };
	}
	if (!json || typeof json !== 'object' || Array.isArray(json)) {
		return {
			...empty,
			exists: true,
			error: `root must be a JSON object, found ${Array.isArray(json) ? 'array' : typeof json}`,
		};
	}

	const warnings = [];
	const bypasses = (Array.isArray(json.bypasses) ? json.bypasses : [])
		.map((entry, index) => readBypass(entry, index, warnings))
		.filter(Boolean);

	return {
		path: file,
		exists: true,
		error: null,
		warnings,
		bypasses,
		clusters: readClusterOverrides(json.clusters, warnings),
	};
}
