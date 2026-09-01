# Contributing

```bash
node --test test/*.test.mjs
```

Every change ships with a test, and the suite must stay green. There are no
dependencies and no build step: Node 22 built-ins only, no `package.json`.

Three rules carry most of the design:

- **The panel never writes.** No `writeFile`, `rm`, `rename`, `mkdir` or
  `createWriteStream` anywhere in `server.mjs`, `lib/` or `bin/`, and no hook,
  MCP server or user script is ever executed. A patch that adds a write is the
  one kind that will not be merged.
- **Nothing is guessed into place.** A scanner that cannot read something
  reports the real error, and one that recognizes nothing says the format may
  have changed. An empty section must never be indistinguishable from a clean
  one.
- **Comments say why, not what.** The code says what it does; a comment earns
  its place by recording the reason, the constraint, or the bug that shaped it.
