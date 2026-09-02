import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverWorkspaceRoots, isAllowedRoot, resolveAnchorRef } from '../lib/workspace-roots.mjs';

// All git activity below is local (init/commit/worktree add/clone) and writes
// only under os.tmpdir(). The module under test itself never runs a
// write-capable git subcommand — it only ever runs `git worktree list
// --porcelain`, `git rev-parse --verify --quiet` and `git symbolic-ref
// --quiet`, all read-only plumbing. This scaffolding is the exception the
// brief allows.

function git(args, cwd) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commitAll(cwd, message) {
	git(
		['-c', 'user.email=harness@example.com', '-c', 'user.name=Harness', 'commit', '--allow-empty', '-q', '-m', message],
		cwd,
	);
}

// Every directory this scaffolding hands back is realpath'd up front so it
// matches whatever the module under test resolves internally (on macOS
// os.tmpdir() itself is a symlink: /tmp -> /private/tmp).
function makeTmpDir(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeGitRepo(base, name, branch) {
	const dir = path.join(base, name);
	fs.mkdirSync(dir);
	git(['init', '-q', '-b', branch], dir);
	commitAll(dir, 'init');
	return dir;
}

// ---------------------------------------------------------------------------
// discoverWorkspaceRoots
// ---------------------------------------------------------------------------

test('a base that does not exist is reported with exists:false and a real error, never thrown', () => {
	const missingBase = path.join(os.tmpdir(), `harness-roots-missing-${Date.now()}`);
	const discovery = discoverWorkspaceRoots({ bases: [missingBase] });
	assert.equal(discovery.bases.length, 1);
	assert.equal(discovery.bases[0].exists, false);
	assert.ok(discovery.bases[0].error && discovery.bases[0].error.length > 0);
	assert.deepEqual(discovery.roots, []);
});

test('discoverWorkspaceRoots never throws even with no home and no bases', () => {
	assert.doesNotThrow(() => discoverWorkspaceRoots({}));
	const discovery = discoverWorkspaceRoots({});
	assert.deepEqual(discovery.bases, []);
	assert.deepEqual(discovery.roots, []);
	assert.ok(discovery.error);
});

test('bases default to <home>/projects when no bases are given', () => {
	const home = makeTmpDir('harness-roots-home-');
	fs.mkdirSync(path.join(home, 'projects'));
	const discovery = discoverWorkspaceRoots({ home });
	assert.equal(discovery.bases.length, 1);
	assert.equal(discovery.bases[0].path, fs.realpathSync(path.join(home, 'projects')));
	assert.equal(discovery.bases[0].exists, true);
});

test('a non-git project directory that is a direct child of the base is included as a root', () => {
	const base = makeTmpDir('harness-roots-base-');
	const plainProject = path.join(base, 'plain-project');
	fs.mkdirSync(plainProject);

	const discovery = discoverWorkspaceRoots({ bases: [base] });
	const root = discovery.roots.find((r) => r.path === plainProject);
	assert.ok(root, 'plain-project should be discovered');
	assert.equal(root.isGitRepo, false);
	assert.equal(root.isWorktree, false);
	assert.equal(root.branch, null);
	assert.equal(root.mainWorktreePath, null);
	assert.equal(root.name, 'plain-project');
});

test("a git repo's worktrees are discovered as separate roots, deduplicated across scans", () => {
	const base = makeTmpDir('harness-roots-wt-');
	const mainRepo = makeGitRepo(base, 'proj', 'dev');
	const wtPath = path.join(base, 'proj-wt-feature');
	git(['worktree', 'add', '-q', wtPath, '-b', 'feat/x'], mainRepo);

	const discovery = discoverWorkspaceRoots({ bases: [base] });

	const mainResolved = fs.realpathSync(mainRepo);
	const wtResolved = fs.realpathSync(wtPath);

	const mainRoot = discovery.roots.find((r) => r.path === mainResolved);
	const wtRoot = discovery.roots.find((r) => r.path === wtResolved);

	assert.ok(mainRoot, 'main worktree discovered');
	assert.ok(wtRoot, 'secondary worktree discovered');
	assert.equal(mainRoot.isGitRepo, true);
	assert.equal(mainRoot.isWorktree, false);
	assert.equal(mainRoot.mainWorktreePath, mainResolved);
	assert.equal(mainRoot.branch, 'refs/heads/dev');

	assert.equal(wtRoot.isGitRepo, true);
	assert.equal(wtRoot.isWorktree, true);
	assert.equal(wtRoot.mainWorktreePath, mainResolved);
	assert.equal(wtRoot.branch, 'refs/heads/feat/x');

	// Deduplication: exactly one entry per resolved path even though both
	// `proj` and `proj-wt-feature` are independently scanned as base children,
	// each of which runs `git worktree list --porcelain` and sees the full set.
	const occurrences = discovery.roots.filter((r) => r.path === mainResolved);
	assert.equal(occurrences.length, 1);
});

test('a directory with a broken .git that git cannot read degrades to isGitRepo:false rather than being dropped', () => {
	const base = makeTmpDir('harness-roots-brokengit-');
	const brokenProject = path.join(base, 'broken');
	fs.mkdirSync(brokenProject);
	fs.writeFileSync(path.join(brokenProject, '.git'), 'not a real git pointer\n');

	const discovery = discoverWorkspaceRoots({ bases: [base] });
	const root = discovery.roots.find((r) => r.path === fs.realpathSync(brokenProject));
	assert.ok(root, 'the root must still be present, never dropped');
	assert.equal(root.isGitRepo, false);
	assert.equal(root.isWorktree, false);
});

test('hasClaudeDir and hasClaudeMd reflect what is actually on disk', () => {
	const base = makeTmpDir('harness-roots-claude-');
	const withClaude = path.join(base, 'has-claude');
	fs.mkdirSync(path.join(withClaude, '.claude'), { recursive: true });
	fs.writeFileSync(path.join(withClaude, 'CLAUDE.md'), '# rules\n');
	const withoutClaude = path.join(base, 'no-claude');
	fs.mkdirSync(withoutClaude);

	const discovery = discoverWorkspaceRoots({ bases: [base] });
	const withRoot = discovery.roots.find((r) => r.path === fs.realpathSync(withClaude));
	const withoutRoot = discovery.roots.find((r) => r.path === fs.realpathSync(withoutClaude));

	assert.equal(withRoot.hasClaudeDir, true);
	assert.equal(withRoot.hasClaudeMd, true);
	assert.equal(withoutRoot.hasClaudeDir, false);
	assert.equal(withoutRoot.hasClaudeMd, false);
});

test('extraRoots are included even when outside every configured base', () => {
	const base = makeTmpDir('harness-roots-extrabase-');
	const outsideProject = makeTmpDir('harness-roots-extra-');
	const discovery = discoverWorkspaceRoots({ bases: [base], extraRoots: [outsideProject] });
	const resolved = fs.realpathSync(outsideProject);
	assert.ok(discovery.roots.some((r) => r.path === resolved));
	assert.equal(isAllowedRoot(discovery, outsideProject), true);
});

test('roots are sorted by name', () => {
	const base = makeTmpDir('harness-roots-sort-');
	fs.mkdirSync(path.join(base, 'zeta'));
	fs.mkdirSync(path.join(base, 'alpha'));
	fs.mkdirSync(path.join(base, 'mid'));
	const discovery = discoverWorkspaceRoots({ bases: [base] });
	const names = discovery.roots.map((r) => r.name);
	const sorted = [...names].sort((a, b) => a.localeCompare(b));
	assert.deepEqual(names, sorted);
});

// ---------------------------------------------------------------------------
// isAllowedRoot
// ---------------------------------------------------------------------------

test('isAllowedRoot accepts a directory that was actually discovered', () => {
	const base = makeTmpDir('harness-roots-accept-');
	const project = path.join(base, 'proj');
	fs.mkdirSync(project);
	const discovery = discoverWorkspaceRoots({ bases: [base] });
	assert.equal(isAllowedRoot(discovery, project), true);
});

test('isAllowedRoot rejects an unknown absolute path and null/undefined candidates', () => {
	const base = makeTmpDir('harness-roots-unknown-');
	const discovery = discoverWorkspaceRoots({ bases: [base] });
	assert.equal(isAllowedRoot(discovery, '/definitely/not/a/discovered/root'), false);
	assert.equal(isAllowedRoot(discovery, null), false);
	assert.equal(isAllowedRoot(discovery, undefined), false);
});

test('isAllowedRoot rejects a symlink inside the base that points outside it', () => {
	const base = makeTmpDir('harness-roots-symlink-');
	const outside = makeTmpDir('harness-roots-outside-');
	const escapeLink = path.join(base, 'escape');
	fs.symlinkSync(outside, escapeLink, 'dir');

	const discovery = discoverWorkspaceRoots({ bases: [base] });
	// The escaping symlink must never even be discovered as a root.
	assert.equal(
		discovery.roots.some((r) => r.path === fs.realpathSync(outside)),
		false,
	);
	assert.equal(isAllowedRoot(discovery, escapeLink), false);
	assert.equal(isAllowedRoot(discovery, outside), false);
});

test('isAllowedRoot rejects a path containing ".." even if it would resolve to a real root', () => {
	const base = makeTmpDir('harness-roots-dotdot-');
	const project = path.join(base, 'proj');
	fs.mkdirSync(project);
	const discovery = discoverWorkspaceRoots({ bases: [base] });

	// path.join would normalize the ".." away before it ever reached the
	// function under test, so it is built with plain string concatenation to
	// make sure the literal ".." segment actually survives to the call.
	const dotdotPath = `${base}/proj/../proj`;
	assert.equal(isAllowedRoot(discovery, dotdotPath), false);
});

test('isAllowedRoot rejects a file path, and file children are never discovered as roots', () => {
	const base = makeTmpDir('harness-roots-file-');
	const filePath = path.join(base, 'not-a-dir.txt');
	fs.writeFileSync(filePath, 'hello\n');

	const discovery = discoverWorkspaceRoots({ bases: [base] });
	assert.equal(
		discovery.roots.some((r) => r.path === filePath),
		false,
	);
	assert.equal(isAllowedRoot(discovery, filePath), false);
});

// ---------------------------------------------------------------------------
// resolveAnchorRef
// ---------------------------------------------------------------------------

function makeAnchorRepo(prefix, branch) {
	const dir = makeTmpDir(prefix);
	git(['init', '-q', '-b', branch], dir);
	commitAll(dir, 'init');
	return dir;
}

test('resolveAnchorRef resolves to dev when dev exists', () => {
	const dir = makeAnchorRepo('harness-anchor-dev-', 'dev');
	const result = resolveAnchorRef({ projectRoot: dir });
	assert.equal(result.ref, 'dev');
	assert.equal(result.source, 'preferred');
	assert.equal(result.error, null);
	assert.deepEqual(result.tried, ['dev']);
});

test('resolveAnchorRef falls back to main when dev is absent', () => {
	const dir = makeAnchorRepo('harness-anchor-main-', 'main');
	const result = resolveAnchorRef({ projectRoot: dir });
	assert.equal(result.ref, 'main');
	assert.equal(result.source, 'fallback');
	assert.equal(result.error, null);
	assert.deepEqual(result.tried, ['dev', 'main']);
});

test('resolveAnchorRef falls back to master when dev and main are both absent', () => {
	const dir = makeAnchorRepo('harness-anchor-master-', 'master');
	const result = resolveAnchorRef({ projectRoot: dir });
	assert.equal(result.ref, 'master');
	assert.equal(result.source, 'fallback');
	assert.deepEqual(result.tried, ['dev', 'main', 'master']);
});

test('resolveAnchorRef returns source:none with a real error when nothing resolves', () => {
	const dir = makeAnchorRepo('harness-anchor-none-', 'trunk');
	const result = resolveAnchorRef({ projectRoot: dir });
	assert.equal(result.ref, null);
	assert.equal(result.source, 'none');
	assert.ok(result.error && result.error.length > 0);
	assert.deepEqual(result.tried, ['dev', 'main', 'master']);
});

test('resolveAnchorRef respects a custom preferred ref', () => {
	const dir = makeAnchorRepo('harness-anchor-custom-', 'release');
	const result = resolveAnchorRef({ projectRoot: dir, preferred: 'release' });
	assert.equal(result.ref, 'release');
	assert.equal(result.source, 'preferred');
	assert.deepEqual(result.tried, ['release']);
});

test('resolveAnchorRef never throws for a non-git directory', () => {
	const dir = makeTmpDir('harness-anchor-nogit-');
	const result = resolveAnchorRef({ projectRoot: dir });
	assert.equal(result.ref, null);
	assert.equal(result.source, 'none');
	assert.ok(result.error);
});

test('resolveAnchorRef reports a missing projectRoot without throwing', () => {
	const result = resolveAnchorRef({});
	assert.equal(result.ref, null);
	assert.equal(result.source, 'none');
	assert.equal(result.error, 'no projectRoot given');
});

test('resolveAnchorRef falls back to the repo default branch via origin/HEAD when nothing else matches', () => {
	const remoteDir = makeTmpDir('harness-anchor-remote-');
	git(['init', '-q', '--bare', '-b', 'trunk'], remoteDir);

	const seedDir = makeTmpDir('harness-anchor-seed-');
	git(['init', '-q', '-b', 'trunk'], seedDir);
	commitAll(seedDir, 'init');
	git(['push', '-q', remoteDir, 'trunk'], seedDir);
	git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], remoteDir);

	const cloneParent = makeTmpDir('harness-anchor-clonebase-');
	const cloneDir = path.join(cloneParent, 'clone');
	git(['clone', '-q', remoteDir, cloneDir]);

	const result = resolveAnchorRef({ projectRoot: cloneDir });
	assert.equal(result.ref, 'trunk');
	assert.equal(result.source, 'default-branch');
	assert.equal(result.error, null);
	assert.deepEqual(result.tried, ['dev', 'main', 'master', 'trunk']);
});

// ---------------------------------------------------------------------------
// Where to look when nobody said

test('with no bases and no ~/projects, the neighbours of the started repo are searched', () => {
	// The `~/projects` default is a guess about one machine's layout. Somebody
	// who keeps repositories in ~/code got a selector holding only the one repo
	// they happened to start in, and no hint that a setting existed.
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-roots-home-'));
	const code = path.join(home, 'code');
	fs.mkdirSync(code);
	const started = makeGitRepo(code, 'started-here', 'main');
	const sibling = makeGitRepo(code, 'a-neighbour', 'main');

	const discovery = discoverWorkspaceRoots({ home, extraRoots: [started] });
	const paths = discovery.roots.map((root) => fs.realpathSync(root.path));
	assert.ok(paths.includes(fs.realpathSync(started)), 'the repo it was started in');
	assert.ok(paths.includes(fs.realpathSync(sibling)), 'and the repo next to it');
});

test('an existing ~/projects still wins over the started repo neighbourhood', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-roots-home-'));
	const projects = path.join(home, 'projects');
	fs.mkdirSync(projects);
	const inProjects = makeGitRepo(projects, 'lives-in-projects', 'main');
	const elsewhere = path.join(home, 'elsewhere');
	fs.mkdirSync(elsewhere);
	const started = makeGitRepo(elsewhere, 'started-here', 'main');
	makeGitRepo(elsewhere, 'a-neighbour', 'main');

	const discovery = discoverWorkspaceRoots({ home, extraRoots: [started] });
	const paths = discovery.roots.map((root) => fs.realpathSync(root.path));
	assert.ok(paths.includes(fs.realpathSync(inProjects)), '~/projects is still searched');
	assert.ok(paths.includes(fs.realpathSync(started)), 'the started repo is always present');
	assert.equal(
		paths.some((entry) => entry.endsWith('/a-neighbour')),
		false,
		'its neighbours are not searched when ~/projects exists',
	);
});

test('the home directory itself is never turned into a search base', () => {
	// A repository checked out directly in $HOME would otherwise make the panel
	// walk the entire home directory looking for more.
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-roots-home-'));
	const started = makeGitRepo(home, 'repo-in-home', 'main');
	fs.mkdirSync(path.join(home, 'Documents'));

	const discovery = discoverWorkspaceRoots({ home, extraRoots: [started] });
	// Compared without realpath: the base it falls back to naming here does not
	// exist, and resolving a missing path throws.
	const realHome = fs.realpathSync(home);
	assert.equal(
		discovery.bases.some((base) => path.resolve(base.path) === realHome || base.path === home),
		false,
		'$HOME must never be a base',
	);
	const paths = discovery.roots.map((root) => fs.realpathSync(root.path));
	assert.deepEqual(paths, [fs.realpathSync(started)], 'only the started repo');
});

test('a ~/projects that exists but is unusable is named, and does NOT widen the search', () => {
	// A symlink to an unmounted drive resolves to nothing, exactly like a
	// missing directory does — but the two mean opposite things. One is "you
	// never had this convention"; the other is "your convention is broken right
	// now". Treating the second as the first silently searched the started
	// repo's neighbours instead, and never mentioned the broken path at all.
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-roots-home-'));
	fs.symlinkSync(path.join(home, 'no-such-volume'), path.join(home, 'projects'), 'dir');
	const code = path.join(home, 'code');
	fs.mkdirSync(code);
	const started = makeGitRepo(code, 'started-here', 'main');
	makeGitRepo(code, 'a-neighbour', 'main');

	const discovery = discoverWorkspaceRoots({ home, extraRoots: [started] });
	assert.ok(
		discovery.bases.some((base) => base.path.endsWith('/projects') && base.exists === false && base.error),
		'the broken base must be reported, not silently skipped',
	);
	const paths = discovery.roots.map((root) => fs.realpathSync(root.path));
	assert.deepEqual(paths, [fs.realpathSync(started)], 'only the started repo, as before');
});

test('the repo it was started in survives even when no base can be resolved', () => {
	// `extraRoots` is what the caller is certain about. Returning early on "no
	// base" threw that away too, leaving an empty selector for a session that
	// plainly had a repository open.
	// The case that actually reaches it: a directory whose parent IS the
	// filesystem root, which the neighbourhood guard refuses. With no home
	// either, no base resolves at all — and the early return took the started
	// root down with it.
	const discovery = discoverWorkspaceRoots({ extraRoots: ['/tmp'] });
	assert.equal(
		discovery.roots.some((root) => fs.realpathSync(root.path) === fs.realpathSync('/tmp')),
		true,
		'the started root is always listed',
	);
	assert.equal(discovery.bases.length, 0, 'and no base was invented for it');
});
