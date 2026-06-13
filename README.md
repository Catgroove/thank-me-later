# thank-me-later (tml)

An extensible "ship it" CLI. Run it when an agent finishes a unit of work and it conducts
a code-defined pipeline — branch, checks, review, open PR, wait on CI. _Spend time now,
thank me later._

> **Status: walking skeleton.** The monorepo is scaffolded and `tml ship` prints
> `Hello World`. The real engine, providers, and default pipeline are not built yet.

## Quick start

```sh
bun install
bunx tml ship      # → Hello World
```

## Commands

```sh
bun run typecheck  # tsc --noEmit across the workspace
bun run lint       # oxlint --type-aware
bun run fmt        # oxfmt (fmt:check to verify)
bun run build      # compile the CLI to dist/tml
bun test           # Bun's test runner
```

## Layout

| Package | Description |
| --- | --- |
| `@tml/core` | Engine: step contract, lifecycle model _(placeholder)_ |
| `@tml/defaults` | Blessed default pipeline plugin _(placeholder)_ |
| `@tml/github` | Forge provider _(placeholder)_ |
| `@tml/pi` | pi host adapter _(placeholder)_ |
| `tml` | CLI/TUI binary |

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the full design at a glance
- [`docs/adr/`](docs/adr/) — locked decisions + rejected alternatives
- [`CONTEXT.md`](CONTEXT.md) — the glossary

MIT © Martin Norberg
