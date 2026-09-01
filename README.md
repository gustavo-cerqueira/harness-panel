# Harness Control Panel

Local, read-only web panel that inventories every harness component applying to
this workspace — Claude Code by default, Codex CLI behind the same selector,
from the enterprise layer down to the worktree layer — and deep-links each row
to its real source file and line.

**<http://127.0.0.1:4546>**

```bash
node server.mjs
# or, idempotent (safe to run twice, frees nothing it does not own):
bin/start.sh
```

It inventories the repository it is started in. Point it elsewhere with
`HARNESS_REPO`, and change the port with `HARNESS_PORT` (default 4546).

## Guardrails, first

The panel opens on the question worth asking first: **what actually stops the
agent from doing damage, and where does it stop watching?** One page, ordered by
how much force each layer really has:

- **Mechanical** — blocking hooks by lifecycle event, `permissions.deny`,
  write boundaries, Codex's forbidden exec patterns and its sandbox mode.
- **Asks first** — `permissions.ask`, the permission mode, Codex's approval
  policy.
- **Intent** — the always-loaded `NEVER` directives from your instruction
  files, which stop drift and enforce nothing.

Above them runs the turn as a pipeline — prompt → UserPromptSubmit →
model → PreToolUse → permissions → execution → PostToolUse → stop — with each
gate drawn at the point it actually fires. Click one and it highlights the rows
that define it. A stage with nothing standing shows a dashed hole rather than
quietly rendering nothing, and a guard switched off (a sandbox on
`danger-full-access`, an approval policy of `never`) is listed for what it is
and left out of the gate count.

## What it answers

- Which `CLAUDE.md` files load, in what order, and what they cost in context.
- Which layer wins each setting — and what lost. Precedence is
  `user < project < local`, with enterprise managed policy over all three. The
  four permission lists (`permissions.allow/deny/ask/additionalDirectories`)
  and every `hooks.<Event>` registration are the exception: every layer's
  entries stay live (`mergeKind: 'union'`, no winning layer), excluded from
  Conflicts because nothing was actually overridden.
- Every hook — settings layers plus the ones enabled plugins register — the
  script it resolves to, whether that script exists, and how many runs the
  transcripts attribute to that hook's own matcher.
- Every skill with its resolved `skillOverrides` state (`on`, `name-only`,
  `user-invocable-only`, `off`), plus dead overrides that match no skill.
- Slash commands, subagents, MCP servers, shared rules, installed plugins and
  the marketplaces they come from. A plugin keeps every version it ever cached,
  so plugin skills, commands and subagents are listed once per cached version
  and each row says whether it is the version that actually loads; the stale
  copies are hidden by default and counted on the section heading.
- MCP servers that reach a session from the claude.ai account or the client
  (connectors, the browser extension, the IDE bridge) — they have no config file
  in any scope, so they are shown for what they are rather than dropped along
  with their call counts.
- Which operational cluster each skill, command, subagent and MCP server falls
  in — Discovery, Specification, Planning, Orchestration, Execution,
  Verification, Delivery, Diagnosis, Memory, Governance, Meta — with the ones
  no rule matched shown as Unclassified rather than guessed into a neighbour.
- Which of the repository's git worktrees have a drifted `settings.local.json`.
- What actually gets injected into a session.

## Two harnesses

One machine often runs both agent harnesses against the same repository, and
they read completely different trees. The `Claude Code` / `Codex CLI` selector in the
header switches the whole panel — every API call, every section, every row —
and gives the Codex view its own accent so the two are never mistaken.

|              | Claude Code                                 | Codex CLI                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per machine  | `~/.claude`, `~/.claude.json`, plugin cache | `~/.codex` (or `CODEX_HOME`), `~/.agents`                                                                                                                                                                                             |
| Per repo     | `.claude/`, `.mcp.json`                     | `.codex/`, `AGENTS.md`                                                                                                                                                                                                                |
| Instructions | the `CLAUDE.md` chain                       | the `AGENTS.md` chain                                                                                                                                                                                                                 |
| Settings     | the `settings.json` cascade                 | `config.toml` cascade (user→profile→project→cli) + `runtime` overlay; profiles are separate `<name>.config.toml` files (only with `--profile`); project `.codex/config.toml` only if trusted; `-c` flags are per-session, not on disk |
| Extra family | —                                           | `Exec policy` (`~/.codex/rules/*.rules`)                                                                                                                                                                                              |

The choice is remembered in `localStorage` **and** mirrored in the address bar,
so <http://127.0.0.1:4546/?harness=codex> opens the Codex view directly and the
link still works when someone else pastes it. On load the URL wins over the
stored preference.

The API takes the same parameter on `/api/state`, `/api/section/<id>`,
`/api/file` and `/api/hook-script`. No `?harness=` means Claude Code; an unknown
one is a `400` listing the real ones, never a silent fall back to the default.

Codex scanners live in `lib/codex/` — all 13 sections plus the shared layer,
TOML-parsing and usage modules have landed. If a scanner throws it still shows
the same honest error row as any other failure — never a blank list that would
read as "nothing configured". See [docs/codex-harness.md](docs/codex-harness.md)
for how each Codex scanner reads its source and the cascade it resolves.

## Which tree it reads

The panel reads the **working tree it was started in**, not the anchor branch —
that is what governs the session you are actually running. Most of what it
inventories (`~/.claude`, `~/.claude.json`, the plugin cache, session
transcripts) lives outside the repo entirely and has one reality per machine,
with no branch at all.

The `Source of truth` card at the top names the tree, the branch, the HEAD, how
far it is from the anchor branch, and lists every tracked config file that
differs from it. Comparison, not substitution: you always see what is live, plus
where it deviates from the anchor. The anchor resolves in order — `dev`, then
`main`, then `master`, then the remote's default branch — and the card names the
one it used. Override it with `HARNESS_ANCHOR_REF`.

**Refresh** re-reads every file from disk on demand; the panel also pushes
updates over SSE when a watched config file changes.

## It never writes

The panel reports on your configuration and must never be able to change it:

- No write call exists in `server.mjs`, `lib/`, or `bin/` — no `writeFile`,
  `appendFile`, `rm`, `rename`, `mkdir`, or `createWriteStream`.
- Every HTTP method except `GET`/`HEAD` gets `405` before routing.
- No hook, MCP server, or user script is ever executed.
- No network calls; every fact comes from local disk.
- Binds `127.0.0.1` only.

The one "edit" affordance is the `vscode://file/<path>:<line>` link on each
row. Your editor does the writing.

## Zero dependencies

Node 22 built-ins only. There is no `package.json` in this directory and
nothing to install.

## Tests

```bash
node --test test/*.test.mjs
```

Note: `node --test <directory>` is **not** supported on Node v22.21.1 — it
resolves the directory as a module and fails with `MODULE_NOT_FOUND`. Use the
glob form above.

## Workspace curation

Two of the panel's answers cannot be read off disk: which operational cluster a
skill YOU wrote belongs to, and whether a guard has a hole somebody verified by
hand. The panel ships neither — it reads them from the repository it inventories,
at `.claude/harness-curation.json`:

```json
{
  "bypasses": [
    {
      "guard": "require-spec-lock.sh",
      "match": "require-spec-lock",
      "text": "Sees only Write/Edit tool calls — writes that go through Bash pass around it.",
      "verified": "2026-08-14"
    }
  ],
  "clusters": { "skills": { "my-own-skill": "execution" } }
}
```

`match` is literal text, matched case-insensitively anywhere in the guard's row
title — never a regular expression, so a curation file can never hand the panel
a pattern that hangs it. Omit `match` for a hole that belongs to no single row
(a git-level gate, an unenforced policy) and it is listed on its own. Cluster
ids are the eleven in `lib/taxonomy.mjs`.

`ownerOnlyKeys` is a third, optional list: settings keys that only their owner
may change, matched the same literal way, badged "owner-only — do not change"
wherever they appear. Nothing is owner-only unless your workspace says so.

Without this file the Guardrails view says so in as many words: an empty bypass
table means nobody has looked, which is not the same as nothing to find.

## Shell alias

Optional, add it yourself — this repo never touches your shell config:

```bash
alias harness="$HOME/path/to/harness-panel/bin/start.sh"
```

## Compatibility stance

Several scanners read formats **neither harness documents or versions**: the
session-transcript JSONL under `~/.claude/projects/`, Codex rollout files, the
plugin cache layout, and fields of `~/.claude.json`. There is no contract to
build against — that is the cost of existing in this category, and any CLI
release may change them without notice. The panel's answer is a rule, not a
promise:

- **Breakage must be loud, never silent.** A scanner that read real files but
  recognized nothing says so in an explicit note on its section (e.g. the
  injected-context scanner reports unknown attachment types by name as
  "format drift") instead of rendering an empty section that reads as "nothing
  here". A scanner that throws becomes an error row with the real message.
- **Nothing is ever guessed into place.** When a format stops matching, the
  panel shows less and says why — it never fabricates rows to look current.

## Honest limits

- The **base Claude Code system prompt** is internal to the harness and not
  readable from disk. The panel says so and never reconstructs it.
- **`SessionStart` hook output** is read from what session transcripts already
  captured, not by executing the hooks — there is no read-only dry-run for an
  arbitrary script, and plugin hooks write to their own stores.
- **MCP auth status** comes from `~/.claude/mcp-needs-auth-cache.json` and is
  labelled as a cache with its mtime. The panel makes no network calls, so it
  cannot know live connectivity.
- **Codex hook executions are not recorded anywhere.** Session rollouts carry
  no "a hook ran and printed this" record, so Hooks usage always shows
  untracked, never zero.
- **Codex custom-prompt invocations carry no provenance.** A `/prompts:x`
  expansion becomes an ordinary user message with no record of which prompt
  produced it, so Commands usage is untracked the same way.
- **Codex plugin hook trust is unverified.** The trust-key format Codex would
  use for a plugin-sourced hook has no recorded example on this machine, so
  those rows carry `trusted: null` rather than a guess.
- **Codex same-name skill/agent precedence is unverified.** Which copy Codex
  would actually load when two skills or two custom agents share a name (user
  vs. project scope) has not been confirmed against Codex's own source; both
  rows are kept and flagged instead of resolved to a winner.

See [docs/architecture.md](docs/architecture.md) for the module map and design
rationale, and [docs/codex-harness.md](docs/codex-harness.md) for the Codex
CLI view in detail.
