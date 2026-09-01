/**
 * Secret masking.
 *
 * The panel reads real settings files, which carry API keys in `env` blocks,
 * MCP `headers`, and hook scripts. Masking happens HERE, at the point of read,
 * so a full secret never reaches the HTTP layer, the SSE stream, or a log line.
 * Callers must mask before serializing, not after.
 *
 * Two independent triggers, because either alone leaks:
 *   - the key NAME looks secret (`ANTHROPIC_API_KEY`)
 *   - the VALUE looks secret regardless of a harmless key name
 */

const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Vendor prefixes and shapes that are secrets wherever they appear. */
const SECRET_VALUE_PATTERNS = [
	/\bsk-[A-Za-z0-9._-]{16,}/g, // OpenAI / Anthropic
	/\bghp_[A-Za-z0-9]{20,}/g, // GitHub personal token
	/\bgho_[A-Za-z0-9]{20,}/g,
	/\bghs_[A-Za-z0-9]{20,}/g,
	/\bAIza[A-Za-z0-9_-]{20,}/g, // Google API key
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
	/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
	/\bAKIA[0-9A-Z]{12,}/g, // AWS access key id
];

/**
 * Credential PAIRS written in prose: an account followed by its password, or a
 * labelled password. Shape-based token patterns cannot catch a plain password,
 * and instruction files do carry them (a sanctioned smoke-test login lives in
 * this workspace's CLAUDE.md). The account stays readable; the secret does not.
 */
const CREDENTIAL_PAIR_PATTERNS = [
	// `user@example.com` / `hunter2`  → keeps the account, masks the password
	/(`?[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`?\s*\/\s*`?)([^\s`'"]{4,})(`?)/g,
	// password: hunter2 | senha = hunter2 | passwd hunter2
	/((?:password|passwd|senha|pwd)\s*[:=]\s*`?)([^\s`'"]{4,})(`?)/gi,
];

/**
 * `scheme://user:password@host` — the password is the secret; scheme, account
 * and host stay readable so the row remains diagnosable. Vendor-shape patterns
 * cannot catch these: a Mongo/Postgres password has no recognizable prefix,
 * and the key name is often an innocent `DATABASE_URL` / `MONGO_DSN`.
 */
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi;

const HIDDEN = '••••';
const MIN_MASKABLE_LENGTH = 9;

export function isSecretKey(key) {
	return typeof key === 'string' && SECRET_KEY_PATTERN.test(key);
}

export function looksLikeSecret(value) {
	if (typeof value !== 'string' || value.length === 0) return false;
	return SECRET_VALUE_PATTERNS.some((pattern) => {
		pattern.lastIndex = 0;
		return pattern.test(value);
	});
}

/**
 * Renders a value as `pre…last4`. Anything too short to mask meaningfully is
 * hidden outright rather than half-revealed, and non-strings are hidden because
 * their shape alone can leak (a number is either public or it is not).
 */
export function maskValue(value) {
	if (typeof value !== 'string' || value.length < MIN_MASKABLE_LENGTH) return HIDDEN;
	return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/**
 * Masks an env-like record. Values are masked when the key looks secret OR the
 * value looks secret; everything else passes through so the panel stays useful.
 */
export function maskEnv(env) {
	const out = {};
	if (!env || typeof env !== 'object') return out;
	for (const [key, value] of Object.entries(env)) {
		if (isSecretKey(key) || looksLikeSecret(value)) out[key] = maskValue(value);
		// A pass-through value can still embed a credential in a connection
		// string; redact it in place so the host and account stay readable.
		else if (typeof value === 'string') out[key] = redactText(value);
		else out[key] = value;
	}
	return out;
}

/**
 * Redacts a whole config file for display.
 *
 * `redactText` alone is not enough here: it only recognises known vendor
 * shapes, so a raw settings.json preview leaks every secret whose prefix is not
 * on that list. This was found by previewing a real file — a vendor key came
 * through in full because `fc-` was not a known shape.
 *
 * So this redacts by KEY NAME as well as by value shape, covering both JSON
 * (`"API_KEY": "value"`) and dotenv (`API_KEY=value`) forms. Key-name matching
 * is the load-bearing half: it catches secrets from vendors nobody enumerated.
 */
export function redactConfigText(text) {
	if (typeof text !== 'string' || text.length === 0) return '';
	const jsonPair =
		/("([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_.-]*)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")/gi;
	const envPair =
		/^([ \t]*(?:export[ \t]+)?[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_.-]*[ \t]*=[ \t]*"?)([^"\n]*)("?)$/gim;
	return redactText(
		text
			.replace(jsonPair, (_match, head, _key, value, tail) => `${head}${maskValue(value)}${tail}`)
			.replace(envPair, (_match, head, value, tail) => `${head}${maskValue(value)}${tail}`),
	);
}

/**
 * Scrubs secret-shaped tokens out of free text (hook script bodies, `.env`
 * excerpts, MCP command lines) while leaving the surrounding text readable.
 */
export function redactText(text) {
	if (typeof text !== 'string' || text.length === 0) return '';
	let out = text;
	for (const pattern of SECRET_VALUE_PATTERNS) {
		out = out.replace(pattern, (match) => maskValue(match));
	}
	for (const pattern of CREDENTIAL_PAIR_PATTERNS) {
		out = out.replace(pattern, (_match, head, _secret, tail) => `${head}${HIDDEN}${tail}`);
	}
	URL_CREDENTIAL_PATTERN.lastIndex = 0;
	out = out.replace(URL_CREDENTIAL_PATTERN, (_match, head, _secret, at) => `${head}${HIDDEN}${at}`);
	return out;
}
