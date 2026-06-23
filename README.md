# thank-me-later (tml)

A fully customizable, extensible "ship it" CLI that comes with sane defaults. Run it when an
agent finishes a unit of work and it conducts a pipeline — branch, checks, review, open PR, wait
on CI. The defaults run **zero-config in any language**; tune them with a `tml.json` (declarative
knobs) or extend them with a local plugin (`export default (tml) => …`). _Spend time now, thank me later._

> **Status: functional.** `tml ship` runs the default pipeline end-to-end against GitHub
> (`gh`) and the pi agent, configurable via `tml.json` + local plugins. The TUI and
> local Run Journal resume are built; PR-comment handling is not built yet.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Catgroove/thank-me-later/master/install.sh | sh
```

Downloads the latest prebuilt binary (macOS/Linux, arm64/x64) to `~/.local/bin/tml`. Override
the location with `TML_INSTALL_DIR`, or pin a release with `TML_VERSION=v0.1.0`.

From source (needs [Bun](https://bun.sh)):

```sh
git clone https://github.com/Catgroove/thank-me-later && cd thank-me-later
bun install && bun run build   # → dist/tml
```

## Quick start

```sh
tml init      # scaffold a starter tml.json (optional - tml ship is zero-config)
tml ship      # snapshot this checkout and run the pipeline in an isolated workspace
```

`tml ship` snapshots your non-ignored checkout state into a disposable workspace under the
local Run Journal, then runs there. You can keep editing the source checkout while the Run
continues; those later edits are not part of the shipment. The pipeline puts the snapshot on
a feature branch (AI-named by default), then commits a clean history - your change, then the
gate's fixes as their own commits - as it formats, lints, type-checks, tests, and reviews
(the agent applies fixes), before pushing and opening a PR and watching CI.

tml is built with tml: every change to this repo ships through `tml ship`.

## Configuration

`tml ship` is **zero-config** — it runs the default pipeline anywhere, in any language. To tune
it, run `tml init` (or hand-write a `tml.json` at the repo root, or `~/.config/tml/tml.json` for
machine-wide defaults; the two deep-merge, project winning):

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Catgroove/thank-me-later/master/packages/cli/schema/tml.schema.json",
  "branch": "require",                          // ai | auto | require
  "models": { "default": "haiku", "review": "opus" },
  "disable": ["typecheck"],                     // drop a default Step
  "plugins": ["./.tml/deep-review.ts"]          // local paths only (for now)
}
```

JSON only **toggles and selects** (providers by name, `branch`, `models`, `disable`). To add or
reorder Steps, write a **local plugin** — a TypeScript file that never imports `@tml/core`:

```ts
// .tml/deep-review.ts
export default (tml) => {
  tml.pipeline.insertAfter("review", tml.defineStep({
    name: "deep-review",
    run: (ctx) => ctx.agent.run("Second, security-focused pass over the diff.").then(() => ({})),
  }));
};
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
| `@tml/core` | Engine: step contract, artifacts, providers (Git/Git provider/Harness), event stream |
| `@tml/defaults` | The blessed default pipeline plugin — branch modes, checks, review, commits, PR, CI |
| `@tml/github` | GitHub Git provider (via `gh`) |
| `@tml/pi` | pi Harness adapter |
| `@tml/view` | Presentation: folds the event stream into view state + CLI/plain renderers |
| `tml` | CLI binary (`tml ship`, `tml init`) |

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the full design at a glance
- [`docs/adr/`](docs/adr/) — locked decisions + rejected alternatives
- [`CONTEXT.md`](CONTEXT.md) — the glossary

MIT © Martin Norberg
