# thank-me-later (tml)

A fully customizable, extensible "ship it" CLI that comes with sane defaults. Run it when an
agent finishes a unit of work and it conducts a code-defined pipeline — branch, checks, review,
open PR, wait on CI. The pipeline and every step are plain TypeScript: use the blessed defaults,
or reorder, replace, and extend them. _Spend time now, thank me later._

> **Status: functional.** `tml ship` runs the default pipeline end-to-end against GitHub
> (`gh`) and the pi agent. The TUI, resume/checkpoint, PR-comment handling, and loading a custom
> `tml.config.ts` aren't built yet.

## Quick start

```sh
bun install
bunx tml ship      # run the pipeline in your checkout
```

`tml ship` runs **in place** in your current checkout, from any starting state. It puts the
work on a feature branch (AI-named by default), then commits a clean history — your change,
then the gate's fixes as their own commits — as it formats, lints, type-checks, tests, and
reviews (the agent applies fixes), before pushing and opening a PR and watching CI.

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
| `@tml/core` | Engine: step contract, artifacts, providers (Git/Forge/Harness), event stream |
| `@tml/defaults` | The blessed default pipeline plugin — branch modes, checks, review, commits, PR, CI |
| `@tml/github` | GitHub Forge provider (via `gh`) |
| `@tml/pi` | pi Harness adapter |
| `@tml/view` | Presentation: folds the event stream into view state + CLI/plain renderers |
| `tml` | CLI binary (`tml ship`) |

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the full design at a glance
- [`docs/adr/`](docs/adr/) — locked decisions + rejected alternatives
- [`CONTEXT.md`](CONTEXT.md) — the glossary

MIT © Martin Norberg
