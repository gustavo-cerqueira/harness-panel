import assert from 'node:assert/strict';
import test from 'node:test';
import { isSecretKey, looksLikeSecret, maskValue, maskEnv, redactConfigText, redactText } from '../lib/mask.mjs';

test('recognises secret-shaped key names, case-insensitively', () => {
	for (const key of [
		'ANTHROPIC_API_KEY',
		'apiKey',
		'GITHUB_TOKEN',
		'client_secret',
		'DB_PASSWORD',
		'GOOGLE_APPLICATION_CREDENTIALS',
	]) {
		assert.equal(isSecretKey(key), true, `${key} should be secret`);
	}
});

test('leaves ordinary key names alone', () => {
	for (const key of ['MODEL', 'PORT', 'NODE_ENV', 'baseUrl', 'timeout']) {
		assert.equal(isSecretKey(key), false, `${key} should not be secret`);
	}
});

test('masks a value down to a short prefix and the last four characters', () => {
	const masked = maskValue('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234');
	assert.match(masked, /^sk-…1234$/);
	assert.equal(masked.includes('abcdefghij'), false);
});

test('short values are fully hidden rather than half-revealed', () => {
	assert.equal(maskValue('abc'), '••••');
	assert.equal(maskValue('12345678'), '••••');
});

test('non-string values are reported by type, never serialized', () => {
	assert.equal(maskValue(null), '••••');
	assert.equal(maskValue(undefined), '••••');
	assert.equal(maskValue(12345678901234), '••••');
});

test('detects secret-shaped values even under an innocent key name', () => {
	assert.equal(looksLikeSecret('sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
	assert.equal(looksLikeSecret('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
	assert.equal(looksLikeSecret('AIzaSyAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
	assert.equal(looksLikeSecret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdef'), true);
	assert.equal(looksLikeSecret('/Users/me/projects/demo'), false);
	assert.equal(looksLikeSecret('opus[1m]'), false);
	assert.equal(looksLikeSecret(''), false);
});

test('maskEnv masks by key name and by value shape, keeping the rest readable', () => {
	const masked = maskEnv({
		ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop1234',
		INNOCENT_LOOKING: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		MODEL: 'opus[1m]',
		PORT: '4546',
	});
	assert.match(masked.ANTHROPIC_API_KEY, /^sk-…1234$/);
	assert.match(masked.INNOCENT_LOOKING, /^ghp…aaaa$/);
	assert.equal(masked.MODEL, 'opus[1m]');
	assert.equal(masked.PORT, '4546');
});

test('maskEnv never returns the original secret anywhere in its output', () => {
	const secret = 'sk-ant-api03-supersecretvalue9876';
	const masked = maskEnv({ ANTHROPIC_API_KEY: secret });
	assert.equal(JSON.stringify(masked).includes('supersecret'), false);
});

test('redactText scrubs secret-shaped tokens out of free text such as hook scripts', () => {
	const script = [
		'#!/usr/bin/env bash',
		'export OPENAI_API_KEY="sk-proj-abcdefghijklmnopqrstuvwxyz1234"',
		'curl -H "Authorization: Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
		'echo done',
	].join('\n');
	const clean = redactText(script);
	assert.equal(clean.includes('abcdefghijklmnop'), false);
	assert.equal(clean.includes('ghp_aaaaaaaaaaaa'), false);
	assert.equal(clean.includes('#!/usr/bin/env bash'), true);
	assert.equal(clean.includes('echo done'), true);
});

test('redactText tolerates empty and non-string input', () => {
	assert.equal(redactText(''), '');
	assert.equal(redactText(null), '');
});

test('redactConfigText masks JSON values by key name, even for unknown vendors', () => {
	// Regression: a raw settings.json preview leaked a vendor key in full,
	// because redactText only knew a fixed list of vendor prefixes.
	//
	// The fixture below is synthetic. The original test pinned the live key as
	// its own fixture, which committed the exact value this test exists to keep
	// out of a preview -- and left it in the history, where editing the file
	// cannot reach it. That key was rotated.
	const config = [
		'{',
		'  "env": {',
		'    "SOMEVENDOR_API_KEY": "vk-0123456789abcdef0123456789abcdef",',
		'    "WEIRDVENDOR_TOKEN": "zz9-totally-unknown-shape-000111",',
		'    "MODEL": "opus[1m]"',
		'  }',
		'}',
	].join('\n');
	const clean = redactConfigText(config);
	assert.equal(clean.includes('0123456789abcdef'), false);
	assert.equal(clean.includes('totally-unknown-shape'), false);
	assert.equal(clean.includes('"opus[1m]"'), true, 'non-secret values stay readable');
	assert.match(clean, /"SOMEVENDOR_API_KEY":\s*"[^"]*…[^"]*"/);
});

test('redactConfigText masks dotenv assignments by key name', () => {
	const env = [
		'# comment',
		'export OPENAI_API_KEY="sk-proj-abcdefghijklmnopqrstuvwxyz1234"',
		'DB_PASSWORD=hunter2hunter2hunter2',
		'PORT=4546',
	].join('\n');
	const clean = redactConfigText(env);
	assert.equal(clean.includes('abcdefghijklmnop'), false);
	assert.equal(clean.includes('hunter2hunter2'), false);
	assert.equal(clean.includes('PORT=4546'), true);
});

test('redactConfigText leaves a file with no secrets untouched apart from nothing', () => {
	const plain = '# Title\n\nJust prose about MODEL and PORT.\n';
	assert.equal(redactConfigText(plain), plain);
});

test('redactText masks a prose credential pair but keeps the account readable', () => {
	const text = 'use `qa@example.com` / `Tr0ub4dor3` as the smoke-test credential; never rotate it';
	const out = redactText(text);
	assert.ok(out.includes('`qa@example.com` / `••••`'), out);
	assert.ok(!out.includes('Tr0ub4dor3'));
	assert.equal(redactText('password: Tr0ub4dor3 and senha = Xyzzy999'), 'password: •••• and senha = ••••');
	assert.equal(redactText('contact qa@example.com for access'), 'contact qa@example.com for access');
});

test('masks the password embedded in a connection-string URL, keeping the rest readable', () => {
	const out = redactText('DATABASE_URL=postgres://admin:s3cretpw@10.0.0.5:5432/app');
	assert.equal(out.includes('s3cretpw'), false);
	assert.ok(out.includes('postgres://admin:'));
	assert.ok(out.includes('@10.0.0.5:5432/app'));
});

test('masks credentials in mongodb and srv-style connection strings', () => {
	for (const text of [
		'mongodb://root:supersenha@mongo:27017/admin',
		'mongodb+srv://ez:hunter22@cluster0.mongodb.net/db',
		'redis://default:redispass@redis.internal:6379',
	]) {
		const out = redactText(`uri: ${text}`);
		assert.equal(/supersenha|hunter22|redispass/.test(out), false, `${text} leaked through`);
	}
});

test('URLs without an embedded credential pass through untouched', () => {
	for (const text of [
		'https://example.com/path?q=1',
		'redis://localhost:6379',
		'postgres://host:5432/db',
		'see a@b.com/x',
	]) {
		assert.equal(redactText(text), text);
	}
});

test('maskEnv keeps a credentialled URL readable except its password', () => {
	const out = maskEnv({
		DATABASE_URL: 'postgres://admin:s3cretpw@db.internal:5432/app',
		BASE_URL: 'http://localhost:3006',
	});
	assert.equal(out.BASE_URL, 'http://localhost:3006');
	assert.equal(out.DATABASE_URL.includes('s3cretpw'), false);
	assert.ok(out.DATABASE_URL.includes('@db.internal:5432/app'));
});

test('redactConfigText catches a credentialled URL under an innocent key name', () => {
	const out = redactConfigText('{"MONGO_DSN": "mongodb://root:supersenha@mongo:27017"}');
	assert.equal(out.includes('supersenha'), false);
});
