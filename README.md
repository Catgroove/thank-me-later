<h1 align="center">thank-me-later</h1>

<p align="center">A "ship it" CLI for the end of an agent's turn.</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <a href="https://bun.sh"><img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-black?style=flat-square"></a>
</p>

<p align="center"><em>Spend time now, thank me later.</em></p>

```
▶ ship
  ✓ Branch     feat/rename-cli-flags
  ✓ Describe
  ✓ Commit
  ✓ Rebase
  ✓ Review
  ✓ Quality
  ✓ Test
  ✓ PR         https://github.com/you/repo/pull/42
  PR gate
    ✓ CI
    ✓ Merge
  ── results ──────────────────
  review     tightened two flag descriptions
             added --resume id parsing
  pr         https://github.com/you/repo/pull/42
■ run finished
```

You run `tml` (shorthand for thank-me-later) when an agent has finished a unit of work.
It conducts a code-defined pipeline: branch, commit, rebase, review, run your checks, open
a PR, and wait on CI. The defaults run **zero-config in any language**. Tune them with a
`tml.json`, or extend them with a local plugin.

> **Status: functional.** `tml` runs the default pipeline end-to-end against GitHub
> (via `gh`) and the pi agent. The TUI and local Run resume are built; PR-comment handling
> is not built yet.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Catgroove/thank-me-later/master/install.sh | sh
```

Downloads the latest prebuilt binary (macOS/Linux, arm64/x64) to `~/.local/bin/tml`. Set
`TML_INSTALL_DIR` to change the location, or `TML_VERSION=v0.1.0` to pin a release.

From source (needs [Bun](https://bun.sh)):

```sh
git clone https://github.com/Catgroove/thank-me-later && cd thank-me-later
bun install && bun run build   # → dist/tml
```

## Quick start

```sh
tml init      # scaffold a starter tml.json (optional — tml is zero-config)
tml           # run the pipeline on your current work
```

`tml` names or reuses a feature branch, describes your change, and commits it in your
checkout. It then returns your checkout to the default branch and hands the feature branch to
a disposable worktree, so you can keep editing while the Run continues — later edits are not
part of the shipment. From there the pipeline rebases onto the latest base, reviews the diff,
runs one quality pass (format, lint, type-check) and your tests, then pushes, opens a PR,
watches CI, and checks merge readiness. Fixes from review and the gates land as their own
commits on top of your change.

Each `tml` run starts a fresh Run. Use `tml --resume` to continue the latest compatible
Run for the branch, or `tml --resume <id>` to resume an exact one. Add `-v` for the full
per-step trail, or `--plain` for append-only output instead of the TUI.

tml is built with tml: every change to this repo ships through `tml`.

## Configure

`tml` is zero-config. To tune it, run `tml init` or hand-write a `tml.json` at the repo
root (or `~/.config/tml/tml.json` for machine-wide defaults; the two deep-merge, project
winning):

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Catgroove/thank-me-later/master/packages/cli/schema/tml.schema.json",
  "branch": "require",                    // ai | auto | require
  "maxFixAttempts": 3,                    // auto-fix cap per round
  "models": { "default": "haiku", "review": "opus" },
  "disable": ["quality"],                 // drop a default step
  "plugins": ["./.tml/deep-review.ts"],   // local paths only (for now)
  "openInBrowser": true                   // open the PR after finish/failure (same as TUI o)
}
```

JSON only **toggles and selects** pipeline behavior: providers, models, branch mode, fix
attempts, and which steps to disable. `openInBrowser` is a presentation toggle - best set
in your global config - that opens the Run's PR in your default browser when the Run
finishes or fails after opening one. It defaults to false. To add or reorder steps, write a plugin.

## Extend

A plugin is a TypeScript file that authors against an injected `tml` API. It never imports
`@tml/core`, and is referenced by local path from `tml.json`:

```ts
// .tml/deep-review.ts
export default (tml) => {
  tml.pipeline.insertAfter("review", tml.defineStep({
    name: "deep-review",
    run: (ctx) => ctx.agent.run("Second, security-focused pass over the diff.").then(() => ({})),
  }));
};
```

The blessed default pipeline is itself just a plugin (`@tml/defaults`) — there is nothing it
can do that yours can't.

## Layout

| Package | What it does |
| --- | --- |
| `@tml/core` | Engine: step contract, artifacts, providers (Git / Git provider / Harness), event stream |
| `@tml/defaults` | The default pipeline plugin — branch, checks, review, commits, PR, CI |
| `@tml/github` | GitHub Git provider (via `gh`) |
| `@tml/pi` | pi Harness adapter |
| `@tml/view` | Presentation: folds the event stream into view state, CLI/plain renderers, and browser helpers |
| `tml` | The CLI binary (`tml`, `tml init`) |

## Design

- **Data for knobs, code for behavior.** Config is declarative; pipelines and plugins are
  TypeScript. No YAML pipeline DSL.
- **Lean on model capability over machinery.** No tiers, caches, or generic mega-interfaces
  for hypothetical needs.
- **Steps stay mostly-pure and unit-testable.** Side effects go through Providers.
- **Core knows nothing of the defaults.** The default pipeline is one pipeline among many.

## Develop

```sh
bun run typecheck   # tsc --noEmit across the workspace
bun run lint        # oxlint --type-aware
bun run fmt         # oxfmt (fmt:check to verify)
bun run build       # compile the CLI to dist/tml
bun test            # Bun's test runner
```

See [`CONTEXT.md`](CONTEXT.md) for the glossary — the canonical meaning of every domain term.

## License

MIT © Martin Norberg
