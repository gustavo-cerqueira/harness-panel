# Codex CLI harness — how the panel reads it

The Codex accent of the panel (`?harness=codex`) reads a completely different
tree than Claude Code's: `~/.codex` (or `CODEX_HOME`), `~/.agents`,
`<repo>/.codex/`, `<repo>/AGENTS.md`, and Codex session rollouts. This is the
narrative detail behind those scanners — [README.md](../README.md) and
[architecture.md](architecture.md) cover the shared registry mechanics
(`HARNESSES`, `?harness=`, caching, live updates) that both harnesses share.

## Layers and cascade (`lib/codex/layers.mjs`)

Codex has no enterprise-policy layer and no per-machine "local" file the way
Claude Code does, so its layer set is smaller:

```
builtin  <  system  <  plugin  <  user  <  project      (later wins)
```

`authority` drives the merge; `listOrder` drives the left nav, and it is
deliberately different — user is listed first because it is the layer edited
most often, but a project-level file still shadows a same-name user-level one.
`system` (skills bundled under `skills/.system/`) is the weakest layer that
still has a real file on disk; `builtin` sits lower still because it is not a
file at all — behavior compiled into the CLI binary — so its authority value
is a placeholder floor, not a confirmed precedence claim. The `user`/`project`
ordering mirrors Claude's cascade; the `system`/`builtin` placement is
best-effort pending confirmation from Codex's own source.

`auth.json` is in `NEVER_READ` — nothing in `lib/codex/` ever builds a path to
it, let alone opens it.

## Config cascade (`lib/codex/settings-merge.mjs`)

`CODEX_SETTINGS_CASCADE` is `['user', 'profile', 'project', 'cli']`, weakest
first, confirmed against Codex 0.149.1's own loader order. Five things carry
the module:

1. **A profile is shown but never wins on its own.** `<codexHome>/<name>.config.toml`
   only applies when the session was started with `--profile <name>`. A
   read-only panel cannot know which profile (if any) a given session picked,
   so every profile entry is emitted with `ignored: true` and a reason naming
   the flag that would activate it — the row still exists, because the panel
   shows what a file WOULD change, not just what is dormant right now.
2. **The project denylist is modelled, not deleted.** Codex refuses a fixed
   set of keys from a project's `.codex/config.toml` — root names
   (`model_provider`, `model_providers`, `notify`, `profile`, `profiles`,
   `otel`, `chatgpt_base_url`, `openai_base_url`, `apps_mcp_product_sku`,
   `responses_api_metadata`) plus the whole `realtime` table — because a
   cloned repo must not be able to repoint the CLI at another endpoint. Those
   entries stay in the output flagged `ignored: true` rather than dropped.
3. **The runtime turn_context outranks every file.** A session records what
   it is ACTUALLY running in each rollout's `turn_context` record — model,
   effort, approval policy, sandbox mode, permission profile. `/model`,
   `/approve`, a `-c` override, and a resumed thread's stored settings all
   land there and in no file on disk. The newest rollout for this project
   contributes a `runtime` layer (`CODEX_MERGE_ORDER` appends it after
   `cli`) that wins for exactly the keys it records — a key absent from
   `turn_context` gets no runtime entry rather than a fabricated one. The
   rollout is streamed line by line, never read whole into memory, because
   rollouts reach 100k+ lines.
4. **`-c` flags never appear as their own layer.** They are per-session
   command-line overrides with nothing written to disk; their only trace in
   this panel is whatever they change in that session's `turn_context`, via
   the `runtime` layer above.
5. **`known` is always `null`, deliberately.** Codex publishes no settings
   schema this panel can check a key against, so claiming a key is unknown
   would be a guess rendered as a red badge.

Unlike Claude's `permissions.allow/deny/ask/additionalDirectories` and
`hooks.<Event>`, no Codex key is known to union across layers — every key
here resolves by precedence (`mergeKind: 'replace'`), because inventing a
union would render a merge the CLI may not perform.

## TOML scanner (`lib/codex/toml.mjs`)

Codex's config is TOML, not JSON, so it needs its own line-tracking scanner —
the counterpart of `lib/json-locate.mjs` — with the same deep-link guarantee:
every rendered value resolves back to the exact line it was written on.

`parseToml(text)` is a hand-written, tolerant recursive-descent parser (not a
validating one). It returns `{ value, locations, errors }`: `value` is a plain
object tree; `locations` is a `Map<string, {line, column}>` keyed by
`JSON.stringify(pathArray)`; `errors` is `[{ line, message }]`. It never
throws — a statement that fails to parse becomes one error at its start line,
and the scanner recovers by skipping to the next line, so a broken
`config.toml` still yields every key it managed to read. A key defined twice
at the same path is also an error, keeping the first value.

Deliberately unsupported, documented rather than silently wrong: multi-line
inline tables; per-key line locations for keys nested inside an inline table
(only the top-level key holding it is deep-linkable); space-separated
datetimes without a `T`; full TOML 1.0 validation (leading-zero integers,
strict redefinition rules, `[[a.b]]` sequencing); and `__proto__` /
`constructor` / `prototype` as a key, which is refused rather than mutating
the object prototype.

## Hooks and the trust hash (`lib/codex/hooks-scan.mjs`)

Codex does not run a hook just because `hooks.json` declares it (read at both
`user` and `project`, plus plugin hook manifests for enabled plugins). It runs
a hook whose canonical digest matches the one recorded in `config.toml` under
`[hooks.state."<key>"] trusted_hash`, written when the user approved it
through `/hooks`. Edit the command afterwards and the hook is still discovered
and listed, but silently never executed — so `trusted` is computed, not
assumed.

The digest is reproduced, not trusted second-hand. `computeHookTrustHash`
implements Codex 0.149.1's canonicalization: build an identity object
`{ event_name, [matcher], hooks: [<one normalized handler>] }` — the matcher
is included only for events on `MATCHER_EVENTS` and only when the group
declares one — sort its keys recursively, `JSON.stringify` the result, and
`sha256` it. A real fixed vector from this machine's own approved hooks:

```
identity → {"event_name":"session_start","hooks":[{"async":false,
  "command":"python3 '/home/you/.claude/hooks/session-brief.py'",
  "statusMessage":"Briefing from Basic Memory","timeout":20,"type":"command"}]}
hash     → sha256:e450688796ad2cb993635c39fb158eabcf13e157a676174e0256887eb1a53b48
```

This reproduces all eight hashes this machine has recorded (four in
`~/.codex/hooks.json`, four in the repo's `.codex/hooks.json`). Plugin hook
manifests are the one place `trustable` is `false`: the trust key is built
from the path the loader used, and no recorded key on this machine names a
plugin file, so whether plugin hooks are keyed this way at all is unverified —
those rows carry `trusted: null` and say why, rather than guessing.

A linked worktree has no `.codex` of its own for this purpose: Codex
substitutes the MAIN checkout's declarations, so the project source is
resolved through `git rev-parse --git-common-dir` and the row names the file
it really read.

## Skills (`lib/codex/skills-scan.mjs`)

Five roots, each with a layer id:

| Root                           | Layer                                          |
| ------------------------------ | ---------------------------------------------- |
| `<codexHome>/skills`           | `user` (deprecated compatibility root)         |
| `<codexHome>/skills/.system`   | `system` (bundled with the CLI)                |
| `~/.agents/skills`             | `user` (preferred user-installed root)         |
| `<projectRoot>/.agents/skills` | `project`                                      |
| `<projectRoot>/.codex/skills`  | `project`                                      |
| plugin cache skills            | `plugin` (`qualifiedName` = `<plugin>:<name>`) |

Only the project root itself is scanned for the two project roots, not every
directory from project root down to cwd. State: Codex disables one skill at a
time via `[[skills.config]]` (`path`, `enabled = false`) — a stopgap
line-based scan pending a `toml.mjs`-based replacement. There is no partial
state like Claude's `name-only` — a skill is `on` or `off`.

Codex does **not** collapse same-name skills across roots the way Claude Code
does — both copies are injected into the catalog with their own paths
(confirmed: the live catalog carries duplicate OpenSpec skill names from both
`.agents/skills` and `.codex/skills`). `shadowedBy` is always `null`; every
collision — including between two roots sharing the same layer id — is
reported through `duplicates` instead. Deterministic precedence for an
implicit same-name invocation is unverified, so the panel never guesses a
winner. Codex has no lifetime dispatch counter, so `usageKnown` is always
`false`.

## Prompts (`lib/codex/prompts-scan.mjs`)

Three kinds of row, one array:

1. Custom prompts — `~/.codex/prompts/*.md`, top-level files only (no project
   layer, no subdirectory namespacing; a session reload is needed after
   edits). Invoked as `/prompts:<stem>`.
2. The built-in static registry (layer `builtin`, `path: null`) — the exact
   0.149.1 tagged registry, not a guess.
3. Aliases (`/cwd`, `/pet`, `/clean`) as their own rows, flagged `aliasOf`.

`invocations` is always `null`: rollouts carry no distinguishable
custom-prompt provenance — a `/prompts:x` expansion becomes an ordinary user
message with no record of which prompt produced it.

## Agents (`lib/codex/agents-scan.mjs`)

Agent TOML files at `<codexHome>/agents/*.toml` (user) and
`<projectRoot>/.codex/agents/*.toml` (project). The `name` FIELD — not the
filename — is the identity, like Claude's frontmatter `name:`. Every `.toml`
file under an agents directory is presumed to be an agent definition; one
missing `name` is still surfaced (`valid: false`), never dropped.

Codex agent files carry no `tools:` allowlist — every custom agent gets its
sandbox/approval configuration's full toolset; `tools` is always `[]` for row
shape parity, not because tools are withheld. `default`, `worker`, `explorer`
are compiled-in and emitted as `layer: 'builtin'` rows; a custom agent sharing
a built-in's name overrides it, recorded in `overriddenBy`. Same-name
collision across user/project scope is unverified against Codex's own source
— both rows are kept and `agentCollisions()` groups them for the panel to
flag, with no claim about which one Codex would load.

## MCP servers (`lib/codex/mcp-scan.mjs`)

Four sources: `user` (`[mcp_servers.*]` in `<codexHome>/config.toml`),
`project` (same table in `<projectRoot>/.codex/config.toml`), `profile`
(`<codexHome>/*.config.toml`, always `ignored: true` — this panel cannot know
which profile a future run will pick), and `plugin` (via
`lib/codex/plugins-scan.mjs`, the single source of truth for cache/enable
state). A plugin server's display `name` is `<plugin>:<server>`, but
`normalizedName` is `mcp__<id with '-' → '_'>` from the bare server id only —
Codex's runtime tool-call namespace is not plugin-prefixed, so matching a
rollout's calls back to inventory needs the bare form. `envKeys` never carries
values, only declared key names from `env`, `env_vars`, and
`env_http_headers` / `http_headers` — no masked-value object is emitted at
all for MCP rows.

## Exec policy (`lib/codex/execpolicy-scan.mjs`)

Codex's own sandbox rule language — `~/.codex/rules/*.rules` and
`<repo>/.codex/rules/*.rules`, a Starlark-like DSL of `prefix_rule(...)`
calls. An `allow` rule grants no capability by itself; it only decides
whether Codex asks before running a command that already fits the active
sandbox. `decision` is `allow` / `prompt` / `forbidden`; when several rules
match the same command, `forbidden > prompt > allow` wins — resolved by Codex
at run time, never simulated here. The hand-rolled parser tokenizes string
literals and `[`/`]` arrays (including nested unions, rendered as a single
`"a|b"` string) and multi-line `prefix_rule(...)` calls; anything it cannot
parse becomes its own row (`decision: 'unknown'`, `note: 'unparsed'`) rather
than being dropped.

## Plugins (`lib/codex/plugins-scan.mjs`)

Walks `<codexHome>/plugins/cache/<marketplace>/<plugin>/<version>/` and
resolves enable state from `[plugins."<name>@<marketplace>"]` in
`config.toml`, checked at both the user config and the trusted project
config, project winning when both declare the key. `.codex-plugin/plugin.json`
fields are each one of three shapes — absent, a relative path string to a
sibling file/dir, or an inline object — and every resolver handles all three.
Codex's plugin cache carries no per-version "live" marker; when more than one
version is cached, the lexicographically last name is used as a deterministic
fallback (best-effort, not a confirmed rule), and every other cached version
is reported in `multipleVersions`.

## Worktree trust (`lib/codex/worktree-trust.mjs`)

A different question than Claude's per-worktree settings-drift check: Codex
has no per-worktree settings file to drift, only a per-path TRUST decision in
`config.toml`. Lookup order is exact canonical path entry, then the main git
repository root for a linked worktree — there is no ancestor-prefix
inheritance: `[projects."/Users/x"]` being trusted does NOT trust
`/Users/x/anything`, only an exact entry for that path or (for a linked
worktree) the MAIN checkout's own exact entry. `sha256`/`bytes` are always
`null` here — there is no per-worktree file to hash, only a `config.toml`
line to point at.

## Rollouts: injected context and usage (`lib/codex/injected-context.mjs`, `lib/codex/usage-scan.mjs`)

Codex has no hook-attachment record the way Claude Code does. What a rollout
DOES carry: `session_meta.payload.base_instructions` (verbatim, never
reconstructed); the latest `turn_context`; `world_state.payload.state.agents_md`
(the assembled AGENTS.md chain); `world_state.payload.state.skills` /
`plugins_instructions` (whether those catalogs were included); developer-role
`response_item` messages (injected catalogs and whatever a SessionStart-style
hook additionally printed — attribution is by matching the first
heading/line, never a stable ID); and user-role messages carrying the older
single-block AGENTS.md form plus the `<environment_context>` block.

`lib/codex/usage-scan.mjs` mines the same rollouts for MCP tool calls
(`{ namespace: "mcp__<server-id, '-'→'_'>", name: "<tool>" }`) and subagent
dispatches (`{ namespace: "collaboration", name: "spawn_agent" }`, with the
agent identity inside the `arguments` JSON string under `agent_type`, or
`agent`/`role`/`name` as fallbacks, else `(default)`). Every rollout is
streamed line by line, never read whole, and only the most relevant sessions
are streamed at all.

**A rollout carries no hook execution record and no custom-prompt invocation
provenance at all.** `commands` and `hooks` in the usage scan are always
returned empty, each with a `notes[]` entry explaining that empty here means
"untracked", never "zero happened".

## Honest limits, Codex side

- No rollout records a hook actually running — Hooks usage stays untracked,
  not zero.
- No rollout distinguishes which custom prompt produced a message — Commands
  usage stays untracked, not zero.
- Plugin hook manifests carry `trusted: null`: the trust-key format Codex
  would use for a plugin-sourced hook is unverified on this machine.
- Deterministic precedence between two same-name skills or two same-name
  custom agents (user vs. project scope) is unverified — both rows are kept
  and flagged, never resolved to a guessed winner.

## Known gaps after Codex's own review (2026-08-26)

Codex upheld hooks, rules, exec policy and worktrees. What the panel does **not** claim:

- **Plugin `enabled` is the config flag**, not runtime evidence. A cached plugin
  with no `[plugins."<id>"]` entry is shown as not enabled even when a bundled
  default activates it at runtime.
- **Effective skills are disk discovery.** The injected `<skills_instructions>`
  catalog of the latest session can be smaller; the panel does not yet cross-check
  it, so "effective" means "on disk and not disabled".
- **The `runtime` layer is the latest observed session for the selected root**,
  which can be older than the session you are in.
- **Injected rows are attributed by content.** Rollouts carry no hook provenance;
  every capture carries `provenance` saying so, and the base instructions are
  labelled incomplete on purpose.
- **MCP usage can read zero** when calls went through the `exec` aggregator.
