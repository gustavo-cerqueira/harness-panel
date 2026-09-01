# Harness Control Panel — architecture

A local, zero-dependency web panel that inventories every harness component
applying to this workspace — Claude Code and Codex CLI, selected in the header —
and deep-links each row to its real source file and line.

## Why it exists

Harness configuration is spread across at least five layers, two home-directory
files, a plugin cache, and ~30 git worktrees. Answering "which value is actually
live, and which file sets it" by hand is slow and error-prone — and a wrong
answer is worse than no answer, because it is acted on. The panel answers that
question from disk, every time, with a link straight to the line.

## Read-only by construction

The panel reports on configuration; it must never be able to change it. That is
enforced structurally, not by convention:

- No `fs.writeFile`, `fs.appendFile`, `fs.rm`, `fs.rename`, `fs.mkdir`, or
  `createWriteStream` appears in `server.mjs`, `lib/`, or `bin/`. All reads go
  through `lib/source-file.mjs`, which only calls `fs.readFileSync` and
  `fs.lstatSync`.
- `server.mjs` rejects every HTTP method except `GET`/`HEAD` with 405 **before
  routing**, so there is no mutating route to reach.
- No hook, MCP server, or user script is ever executed. `child_process` appears
  exactly once, in `lib/worktree-drift.mjs`, restricted to
  `git worktree list --porcelain` via `execFileSync` with a timeout and no shell.
- No network calls. Every fact comes from local disk.

The single "edit" affordance is a `vscode://file/<abs-path>:<line>` link — the editor does the writing, the panel hands over the exact coordinates.

## Harness registry (`HARNESSES` in `server.mjs`)

The panel inventories two harnesses from one server. `HARNESSES` maps an id to
everything that differs between them — section list, usage scanner, watch
targets, and what the panel will claim about the base system prompt — so no
request handler branches on which harness it is serving, and a third harness
would be a third entry rather than a third code path.

`?harness=` selects one on `/api/state`, `/api/section/<id>`, `/api/file` and
`/api/hook-script`; missing means `claude`. An unknown id is refused with `400`
and the list of real ones — coercing it to the default would answer a Codex
question with Claude's inventory, the exact failure this panel exists to
prevent. `/api/section/<id>` validates the id against **that** harness's
registry, so `execpolicy` is a section for Codex and a `404` for Claude.

State and usage caches are keyed by `harness:root`. Both harnesses' watch
targets are registered at boot, since a watcher started on first selection
would miss an edit made while the other view was open. The `update` SSE event
carries `harness`, `null` when the change cannot be attributed to one; the
client refetches on its own harness and on `null`, never on the other's —
one wasted re-read is cheaper than a stale panel.

The Codex sections reuse the Claude section IDS deliberately: `public/app.js`
keys its adapters by id, so a Codex scanner that emits the same row shape
renders through the same code, with no second UI to keep in sync.

| Section id   | Label                          | Module                           |
| ------------ | ------------------------------ | -------------------------------- |
| `memory`     | Instructions (AGENTS.md chain) | `lib/codex/memory-chain.mjs`     |
| `settings`   | Config (config.toml)           | `lib/codex/settings-merge.mjs`   |
| `hooks`      | Hooks                          | `lib/codex/hooks-scan.mjs`       |
| `skills`     | Skills                         | `lib/codex/skills-scan.mjs`      |
| `commands`   | Commands & custom prompts      | `lib/codex/prompts-scan.mjs`     |
| `agents`     | Custom agents                  | `lib/codex/agents-scan.mjs`      |
| `mcp`        | MCP servers                    | `lib/codex/mcp-scan.mjs`         |
| `directives` | Directives                     | `lib/codex/directives-scan.mjs`  |
| `rules`      | Rules                          | `lib/codex/rules-scan.mjs`       |
| `execpolicy` | Exec policy                    | `lib/codex/execpolicy-scan.mjs`  |
| `plugins`    | Plugins                        | `lib/codex/plugins-scan.mjs`     |
| `worktrees`  | Worktree trust                 | `lib/codex/worktree-trust.mjs`   |
| `injected`   | Injected context               | `lib/codex/injected-context.mjs` |

All 13 scanners above have landed, plus two shared modules every one of them
depends on — `lib/codex/layers.mjs` (layer definitions and absolute paths) and
`lib/codex/toml.mjs` (the TOML line-tracking parser, Codex's counterpart of
`lib/json-locate.mjs`) — and the usage source, `lib/codex/usage-scan.mjs`,
which mines session rollouts for MCP and subagent call counts. If a scanner
throws at runtime it still degrades to the honest error row `runSection()`
already produces rather than taking the panel down. See
[docs/codex-harness.md](codex-harness.md) for the cascade, the hooks trust-hash
algorithm, skill/agent duplicate policy, and the rest of the per-module detail.

Two shapes have no Claude counterpart, and the UI carries both: the `execpolicy`
section, and a `trusted` flag on hooks (Codex records a hash of each hook script
it was told to trust, so a mismatch means the file changed since). Claude hooks
carry no such field and render exactly as before.

## Layer model (`lib/layers.mjs`)

Precedence is **not** the order the layers are usually listed in. The real
Claude Code cascade is:

```
user  <  project  <  local          (later wins)
enterprise managed policy           (overrides all three)
```

`authority` drives the merge, `listOrder` drives the navigation. Rendering the
reading order as authority would make the panel confidently wrong about which
value is live — the exact failure mode it exists to prevent.

One documented exception, encoded as `AUTO_MODE_TRUSTED_LAYERS`:
`permissions.defaultMode: "auto"` is honoured only from enterprise or user
settings (or a CLI flag), because project and local files are repo-controllable.
A project or local `defaultMode` set to any _other_ mode does win normally.

A second exception is a merge shape, not a precedence override: the four
permission lists (`permissions.allow`, `deny`, `ask`, `additionalDirectories`)
and every `hooks.<Event>` registration are UNION-merged rather than resolved
to one winner — every layer's entries stay live (`mergeKind: 'union'`,
`winningLayer: null`), which is why they are excluded from Conflicts. Codex's
own cascade has no such exception; every Codex key resolves by precedence
(see [docs/codex-harness.md](codex-harness.md)).

## Module map

| Module                     | Answers                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `lib/json-locate.mjs`      | Which line defines this JSON key? (powers every deep link)                  |
| `lib/source-file.mjs`      | The one read primitive: content, metadata, symlink, real errors             |
| `lib/mask.mjs`             | Secret masking, by key name and by value shape                              |
| `lib/layers.mjs`           | Layer identity, precedence, absolute paths                                  |
| `lib/memory-chain.mjs`     | Which CLAUDE.md files load, in what order, at what token cost               |
| `lib/settings-merge.mjs`   | Which layer wins each key, and what lost                                    |
| `lib/hooks-scan.mjs`       | Every hook — settings layers AND enabled plugins — and its script           |
| `lib/skills-scan.mjs`      | Every skill and its resolved `skillOverrides` state                         |
| `lib/commands-scan.mjs`    | Slash commands, user-typed-only ones, and stale plugin-version copies       |
| `lib/agents-scan.mjs`      | Subagents, their models and tools, invalid and stale-version definitions    |
| `lib/mcp-scan.mjs`         | MCP servers per scope, masked env, cached auth status                       |
| `lib/rules-scan.mjs`       | Shared rules and which CLAUDE.md section cites them                         |
| `lib/directives-scan.mjs`  | Every imperative directive (NEVER/MUST/SHOULD/...) buried in memory + rules |
| `lib/plugins-scan.mjs`     | Installed plugins, their marketplaces, and what each contributes            |
| `lib/worktree-drift.mjs`   | Which worktrees' per-machine settings have diverged                         |
| `lib/injected-context.mjs` | What actually gets injected into a session                                  |
| `lib/taxonomy.mjs`         | Which operational cluster a skill, command, subagent or server belongs to   |
| `lib/curation.mjs`         | The workspace's own judgements: cluster overrides and verified bypasses     |

`server.mjs` imports each scanner **lazily and independently**. A module that
is missing or throws becomes an error row carrying the real message and path;
it never takes the panel down and never degrades into fabricated data.

### Directives (`lib/directives-scan.mjs`)

Walks the same file set as `lib/memory-chain.mjs` (user + project + nested
CLAUDE.md) plus the shared rules catalog, and pulls out every imperative
sentence as its own row — one severity per row (prohibition/requirement/
caution), with the source file, line and the always-loaded-vs-on-demand flag
carried over from that file's kind. A keyword only counts in its two
deliberate-emphasis forms (exact ALL-CAPS anywhere, or Title-case at a
sentence's start), so ordinary prose never gets misread as a directive.

## Clusters (`lib/taxonomy.mjs`)

Skills, slash commands, subagents and MCP servers are also grouped by what they
are FOR. Past a hundred-odd skills a flat list stops being an inventory, so each
row carries a cluster: Discovery, Specification, Planning, Orchestration, Execution,
Verification, Delivery & Operations, Diagnosis, Memory & Context, Governance,
Meta — plus Unclassified.

The bar for a top-level cluster is that **one sentence can say when it fires,
and that sentence distinguishes it from its neighbours**; anything finer is a
cross-cutting tag and stays out — a taxonomy fine enough to be elegant is too
fine to route with. Each row also carries `clusterSource`, because the three
ways a label is derived are not equally trustworthy:

| Source   | Meaning                                                                      |
| -------- | ---------------------------------------------------------------------------- |
| `exact`  | Curated by qualified name. Always beats a family rule.                       |
| `family` | A `plugin:*` rule — right for the plugin's centre of gravity, wrong at edges |
| `none`   | Nothing matched. Lands in Unclassified.                                      |

The shipped maps name only what a stranger can install — official plugins and
bundled skills. A skill you wrote is unknowable from here, so the workspace
declares it in `.claude/harness-curation.json` (`lib/curation.mjs`), and those
entries beat everything shipped.

Unclassified is a real rendered group with a real count. Sweeping an unknown
skill into the nearest plausible cluster would hide it exactly where nobody
looks for it, and would be the panel inventing a fact it does not have. Each
group header states how many of its members came from a family rule.
Frontmatter is deliberately not a source: most skills here live in the plugin
cache, are not ours to edit, and are wiped on the next plugin update.

Empty clusters are reported as coverage gaps for **skills and slash commands
only** — things this workspace authors; subagents and MCP servers are not
stage-shaped, and listing seven empty clusters under six servers is noise
rather than a finding.

## What the panel deliberately does not claim

The base Claude Code system prompt is internal to the harness and not readable
from disk. The panel reports it as _"not exposed by the harness"_ and never
reconstructs it.

Likewise, `SessionStart` hook output is read from what session transcripts
already captured, **not** by executing the hooks: there is no read-only dry-run
for an arbitrary script, and running one to display its output would break the
guarantee the whole panel rests on.

MCP auth status comes from `~/.claude/mcp-needs-auth-cache.json`, labelled as a cache with its mtime: no network calls, so no claim about live connectivity. The always-resident headline counts the memory chain, the effective skill listing and session-start hook output, and says on the card what it leaves out.

## Joining usage to configuration (`mergeUsage` in `server.mjs`)

The scanners read config; `lib/usage-scan.mjs` mines session transcripts. The
two are joined by `mergeUsage`, exported and unit-tested on its own because
every defect it has had lived in the join rather than in either side:

- **Slash commands** are written `/name` in a transcript and `name` on disk.
  Both sides are keyed with the slash stripped; without that, every command in
  the workspace reported zero invocations.
- **Hooks** are counted per `(event, tool)` — `usage-scan` keys them by
  `hookEvent` plus a `hookName` carrying the trigger as an `Event:Tool` suffix.
  A row only claims a bucket whose tool its own matcher admits (`|` splits
  alternatives; absent, empty or `*` means every tool); a row admitting none
  shows `no runs recorded for this matcher` instead of a borrowed number.
  `timingScope` names which of the three cases a row is in and how many other
  rows share it.
- **MCP servers** with no config row in any scope are kept rather than dropped.
  Connectors, the browser extension and the IDE bridge reach a session from the
  claude.ai account or the client itself, so they have no file to hang off; they
  are appended with scope `account/client`, which renders in a neutral colour
  precisely because it is not a layer of the cascade.
- **Subagents** built into the CLI have no definition file either, and are
  appended the same way with layer `builtin`.

## Discovered vs effective

The scanners report everything they find on disk — a scanner must never hide a
file because something else claims it is inactive. But summing them naively
overstates the real cost badly, so `server.mjs` computes a `derived` block that
separates the two numbers:

- The plugin cache keeps several versions of the same plugin side by side
  (`superpowers` 5.1.0/6.3.0, `claude-mem` 13.6.2/13.15.2 were both present
  when this was written), so their skills would otherwise count once per
  cached version.
- Disabled plugins still have their skills on disk.
- A skill shadowed by a higher-scope copy of the same name never loads.
- `off` and `user-invocable-only` skills are hidden from the model.

On a well-stocked machine that gap runs to roughly half: a hundred-odd skills
discovered against half as many that actually load. A headline number
that is quietly wrong is worse than no headline number, so the panel shows both
and labels which is which.

### Stale cached plugin versions

A plugin keeps every version it has ever cached, and each version directory
carries a full copy of that plugin's commands, subagents, skills and hooks —
only one version loads. Scanners still report all of them, but every
plugin-sourced row is stamped with its `pluginVersion` and an `activeVersion`
boolean resolved by `pickActiveVersion` in `lib/plugins-scan.mjs`, the one
rule all of them share.

The panel hides the stale copies by default in Commands and Subagents, the
same way Skills does, and says on the heading how many it is holding back.
`lib/hooks-scan.mjs` is the exception: a hook in a stale version cannot fire
at all, so it is never listed as a hook in the first place.

### Known limitation: multi-version plugin selection is time-sensitive

`pickActiveVersion` asks `~/.claude/plugins/installed_plugins.json` first — a
declared `installPath` beats anything inferred from the cache — and only falls
back to the most recently touched `.in_use` marker when nothing declares one.

That fallback is time-sensitive: Claude Code touches `.in_use` on every session
load, so two runs minutes apart can legitimately resolve to different versions,
moving the `effective` skill count by a few entries between refreshes — real
state changing underneath, not a defect. The marker alone was measured wrong on
two counts — a stale `.in_use` left on a superseded version, and a plugin with
no marker at all — which is why the declared record is consulted first.

## Live updates

`fs.watch` on the config files, debounced, pushing an `update` event over SSE at
`/api/events`. No polling loop. The client refetches `/api/state` on the event,
so an edit made in VSCode appears in the panel within about a second.

## Endpoints

| Method             | Path                | Returns                                        |
| ------------------ | ------------------- | ---------------------------------------------- |
| GET                | `/`                 | the panel UI                                   |
| GET                | `/api/state`        | full inventory, all sections                   |
| GET                | `/api/section/<id>` | one section                                    |
| GET                | `/api/roots`        | git worktrees this panel may read              |
| GET                | `/api/file`         | one inventoried file, for the in-panel preview |
| GET                | `/api/hook-script`  | one hook script body (allowlisted paths only)  |
| GET                | `/api/events`       | SSE stream                                     |
| _any other method_ | —                   | `405`                                          |

`/api/state`, `/api/section/<id>`, `/api/file` and `/api/hook-script` all accept
`?harness=claude|codex` (default `claude`, unknown `400`). `/api/roots` does not:
worktrees are a property of the repo, not of a harness.

`/api/hook-script` refuses any path that does not appear in the scanned hooks
inventory **of the requested harness**, so it cannot be used to read the
filesystem at large, and neither harness can widen the other's boundary.
