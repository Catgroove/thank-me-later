# thank-me-later (tml)

An extensible "ship it" CLI/TUI tool. You run it when an agent has finished a unit of
work; it conducts a code-defined pipeline that branches, runs checks, reviews, opens a
PR, and waits on CI. Shorthand **tml** — "spend time now, thank me later."

## Tech stack

- **TypeScript on Bun** (runtime, test runner, bundler, workspaces).
- **oxc toolchain:** `oxlint --type-aware` (via `oxlint-tsgolint`) + `oxfmt` formatter.
- **OpenTUI** (+ Solid reconciler) for the TUI.
- **Monorepo** via Bun workspaces; versioning via Changesets.
- Single-binary distribution via `bun build --compile`.

## Repo layout

```
packages/
  core/      @tml/core      — engine, step contract, Pending/until, lifecycle model
  defaults/  @tml/defaults  — the blessed default pipeline (just a plugin)
  github/    @tml/github    — Git provider
  pi/        @tml/pi        — pi host adapter
  view/      @tml/view      - presentation: event fold, CLI/plain renderers, browser helpers
  cli/       tml            — CLI/TUI binary
docs/
  ARCHITECTURE.md           — every locked design decision, at a glance
  adr/                      — the big decisions with rationale + rejected options
  specs/                    — feature specs + implementation plans
CONTEXT.md                  — the glossary (domain vocabulary)
```

## Commands

```sh
bun install            # install workspace deps
bun run typecheck      # tsc --noEmit across the workspace
bun run lint           # oxlint --type-aware
bun run fmt            # oxfmt --write .   (fmt:check to verify; markdown excluded)
bun run build          # bun build --compile the CLI to dist/tml
bun test               # run tests (Bun's built-in runner)
bunx tml ship          # run the pipeline
```

## Releases (Changesets)

- **Add a changeset for any user-facing change:** `bun changeset` (pick packages + bump). The
  release workflow (`.github/workflows/release.yaml`) keeps a "Version Packages" PR open from
  accumulated changesets; **merging that PR cuts a release** — `scripts/release.sh` cross-compiles
  the binaries (`scripts/build-binaries.sh`) and publishes a GitHub Release. No manual tagging.
- The binary's version is the `tml` package version; `updateInternalDependencies: patch` means any
  `@tml/*` bump patch-bumps `tml`. Users install via `install.sh` (curl) from the latest Release.

## Conventions

- **Data for knobs, code for behavior.** Config is `tml.json` (declarative: providers, models,
  branch, maxFixAttempts, openInBrowser, disable, plugins). Pipelines and Plugins are TypeScript,
  authored against an injected API and never importing `@tml/core`. No YAML pipeline DSL. See
  `docs/adr/` (ADR-0015).
- **Keep it simple.** Lean on model capability over machinery; don't add abstractions
  (tiers, caches, generic mega-interfaces) for hypothetical needs. See `docs/adr/`.
- **Plugins author against the injected `tml` API** (`export default (tml) => {…}`); they never
  import `@tml/core`, and are referenced by local path from `tml.json`.
- Steps stay mostly-pure and unit-testable; side effects go through Providers.
- **Never reference ADRs in code.** No `ADR-NNNN` citations in source or test files (comments
  included). Code comments explain the rationale in their own words; ADRs live in `docs/adr/`
  and are referenced only from other docs. ADR numbers churn and rot when cited from code.

## Where to read more

- **`docs/ARCHITECTURE.md`** — the full design at a glance (start here for *what* and *why*).
- **`docs/adr/`** — hard-to-reverse decisions with their rejected alternatives.
- **`CONTEXT.md`** — the glossary; the canonical meaning of every domain term.
