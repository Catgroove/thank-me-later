# tml

## 0.2.1

### Patch Changes

- 31e1102: Make the compiled binary hermetic. A standalone Bun executable auto-loads `bunfig.toml` and `.env` from its runtime cwd, so running `tml` inside a project with a `bunfig.toml` `preload` (such as this repo's `@opentui/solid/preload`) aborted startup with `preload not found`. The build now opts out of both autoloads, so the host project's bun config no longer leaks into tml.

## 0.2.0

### Minor Changes

- 060cf35: Isolate `tml ship` runs with a branch -> commit -> worktree model. `branch`, `describe`, and
  `commit-change` now run in your own checkout; the run then switches your checkout back to the
  default branch and hands the feature branch to a disposable git worktree where the rest of the
  pipeline (rebase, checks, review, open-pr, ci-wait) runs. After a successful run your checkout is
  clean on the default branch and the feature branch carries the full shipped history. This replaces
  the previous up-front `git clone` workspace: a worktree shares the repo's object store, so the
  branch and its commits are real in your repo throughout and there is nothing to reconcile after the
  PR merges.

  The `test` check now runs the project's test command (discovered from project config) instead of
  inspecting source. `format`, `lint`, and `typecheck` are unchanged - they remain model-backed source
  inspection.

  `@tml/core` adds an `isolate` marker to the Step contract and a `stopAfter` engine option (the host
  uses them to split the run at the isolation boundary), and replaces the `createIsolatedWorkspace` /
  `removeIsolatedWorkspace` workspace helpers with `createWorktree` / `removeWorktree`.

- 49d5d49: Make the review step converge instead of churning:

  - Review asks a finishable question - bugs, risks, and safe non-functional simplifications in the changed code, nothing about styling/lint/types - and returns no findings when the change is clean. The open-ended "thermo-nuclear" restructuring mandate is gone.
  - Findings are triaged by action: only safe, mechanical issues are `auto-fix`; anything touching the author's intent (architecture, product behaviour) is `ask-user` and goes to the human approval gate, never looped on. Default is `ask-user` when in doubt.
  - Review does not re-review. It applies one fire-and-forget fix pass to the safe `auto-fix` findings and stops; it never runs a verify pass over its own judgement, so it cannot churn or re-surface findings you already decided on. The global `maxFixAttempts` now governs only the objective quality/test/ci checks, which converge by re-running their tool. A clean diff is one pass; obvious fixes cost one more; `ask-user` findings reach you once at the gate.

  Token cost is also cut: review no longer inlines the branch diff into every pass (it hands the agent the base ref and lets it read the worktree), round history fed to fresh agents is a compact, detail-free ledger, and the review preamble is a tight instruction block.

  BREAKING: the `--auto` ship flag and the auto-approval policy are removed. With review converging on its own, the human approval gate is the stopping point; auto-resolving it would auto-fix the `ask-user` findings that must reach a human. The `@tml/core` exports `autoApproveResponder`, `autoApproveFindings`, and `ApprovalDecisionSource`, and the `RoundRecord.approvalSource` field, are removed.

- e603844: Run `tml ship` in an isolated snapshot workspace by default so source checkout edits, ignored files, and review resets do not interfere with active runs.
- a9f93ca: Add a full-screen OpenTUI/Solid TUI as the default interactive presentation for `tml ship`. A TTY now opens an alternate-screen dashboard - an ordered Pipeline rail, a generic per-Step inspector (Summary, Artifacts, Findings, Rounds), and an always-visible activity panel that follows the full cross-Step trail - and resolves `ctx.ask`/`ctx.approveFindings` through inline drawers. `--plain`/`--no-tui` and non-TTY output keep the existing append-only renderer. Every `RunEvent` now carries an `at` timestamp and the engine emits `round:recorded`, so completed durations and Finding/Round data come from structured events rather than renderer-local guesses. The TUI is Pipeline-generic: it makes no assumptions about the default Step names.
- c209d54: Rename the code-host provider concept to Git provider across the public API and config. The new names are `ctx.gitProvider`, `providers.gitProvider`, `Selection.gitProvider`, `registerGitProvider`, `GitProvider`, and `createGitHubProvider`.

### Patch Changes

- a7ad94a: Let ctrl-c abort a Run that is parked on a human gate. A Step waiting on `ctx.ask` or
  `ctx.approveFindings` was previously unreachable by the abort signal: those responder Promises only
  settle when the operator answers, so the drive loop never returned to its `signal.aborted` check and
  the Run hung - pressing ctrl-c (or `y`) at the abort prompt did nothing. The engine now races the
  gate's responder against the Run's signal and rejects with `AbortError` the moment it fires, so the
  Run ends as cancelled, the same way an aborted `until`/agent does. Gates reached over any renderer
  (TUI or plain) are now cancellable.
- bbe9356: Replace cross-round finding-id stall detection with agent-owned verification, a no-progress stop when fixes produce no commit, and a configurable `maxFixAttempts` `tml.json` knob.
- 5b299f9: Add `tml ship --auto` for non-interactive finding gates with bounded auto-fix behavior and blocker-safe aborts.
- b82db55: Add round-based CI auto-fix with failed check log retrieval for GitHub, plus structured local approval gates for default check and review findings.
- f0d0ff2: Add `--help`/`-h` (and bare `tml`) to print usage listing the `ship` and `init` commands and their flags. Command-level `tml ship --help` / `tml init --help` show the same help.
- cfbf53d: Convert the default format, lint, typecheck, and test steps to core round loops with structured check findings, fresh fix rounds, verification rounds, and executor-managed fix commits.
- 6a2f301: Add a file-backed Run Journal that persists local run metadata, completed steps, artifacts, agent rounds, and optional events for crash/resume foundations.
- 382c688: Make `tml ship` start a fresh isolated run by default. Use `tml ship --resume` to resume the latest compatible parked run for the current branch, or `tml ship --resume <id>` for an exact run.
- fd65104: Run the default format and lint gates as model-backed source inspection instead of invoking repository quality toolchains during check rounds. Checks now carry an explicit inspect/run mode, so a gate that must execute its toolchain (typecheck, test) opts into running its command while format and lint stay read-only.
- c065c58: Make review approvals fix the operator's visible finding selection, record review rounds live, and correlate phase events with stable span ids.
- 77ac03a: Convert the default review step to the core round executor, with fresh verification passes and executor-managed review fix commits.
- 1c6baf3: Add a reusable round executor for fresh check, fix, commit, and verification loops.
- b8adcbb: Introduce shared Finding and RoundRecord records, deterministic finding IDs, journaled completed rounds, and PR-summary render helpers for review, checks, and CI.
- fc5b5d3: Keep the full-screen TUI up when the pipeline finishes instead of tearing it down the instant the run
  ends. After a finished (or failed) run the dashboard stays interactive - the pipeline rail, inspector,
  and activity panel remain navigable - with a banner showing the outcome and the PR link, and leaves
  only when the user presses `q`/`enter`/`esc`. `@tml/view` adds an optional renderer `complete()`
  hook for post-run lifecycle policy; the TUI uses it to wait before teardown. Plain/non-TTY renderers
  omit it, so CI and piped runs still return the moment the run ends. A user-driven cancel still exits
  at once.
- Updated dependencies [a7ad94a]
- Updated dependencies [bbe9356]
- Updated dependencies [c24c726]
- Updated dependencies [5b299f9]
- Updated dependencies [e18a90a]
- Updated dependencies [7a7f09b]
- Updated dependencies [060cf35]
- Updated dependencies [b82db55]
- Updated dependencies [bd11587]
- Updated dependencies [7d7a72d]
- Updated dependencies [30a20ba]
- Updated dependencies [cfbf53d]
- Updated dependencies [e93c574]
- Updated dependencies [49d5d49]
- Updated dependencies [1ab80df]
- Updated dependencies [6a2f301]
- Updated dependencies [82ea0a4]
- Updated dependencies [2958361]
- Updated dependencies [66cac4a]
- Updated dependencies [1085512]
- Updated dependencies [fdd146c]
- Updated dependencies [236a193]
- Updated dependencies [4ebf457]
- Updated dependencies [e603844]
- Updated dependencies [a9f93ca]
- Updated dependencies [4f593a7]
- Updated dependencies [1d7fb72]
- Updated dependencies [fd65104]
- Updated dependencies [45fa664]
- Updated dependencies [e4a711f]
- Updated dependencies [a9f93ca]
- Updated dependencies [1ce2958]
- Updated dependencies [edad77f]
- Updated dependencies [48c49a7]
- Updated dependencies [59e6b03]
- Updated dependencies [10da889]
- Updated dependencies [6b227d1]
- Updated dependencies [f740d49]
- Updated dependencies [252b0ea]
- Updated dependencies [c209d54]
- Updated dependencies [060cf35]
- Updated dependencies [577b729]
- Updated dependencies [fc5b5d3]
- Updated dependencies [c065c58]
- Updated dependencies [ae29294]
- Updated dependencies [6b227d1]
- Updated dependencies [77ac03a]
- Updated dependencies [1c6baf3]
- Updated dependencies [728abc0]
- Updated dependencies [e3a1b4d]
- Updated dependencies [b8adcbb]
- Updated dependencies [060cf35]
- Updated dependencies [ef44a8d]
- Updated dependencies [c332844]
- Updated dependencies [dcf7534]
- Updated dependencies [3be5d19]
- Updated dependencies [2f7c7a8]
- Updated dependencies [a9f93ca]
- Updated dependencies [b444dde]
- Updated dependencies [e18ad76]
- Updated dependencies [fc5b5d3]
- Updated dependencies [a9f93ca]
- Updated dependencies [82ea0a4]
- Updated dependencies [7dc58ab]
- Updated dependencies [cad7ab9]
  - @tml/core@0.2.0
  - @tml/defaults@2.0.0
  - @tml/view@2.0.0
  - @tml/github@2.0.0
  - @tml/pi@2.0.0

## 0.1.1

### Patch Changes

- Updated dependencies [cafb140]
- Updated dependencies [cafb140]
- Updated dependencies [cafb140]
- Updated dependencies [d7ae10f]
  - @tml/defaults@1.0.0
  - @tml/core@0.1.0
  - @tml/github@1.0.0
  - @tml/pi@1.0.0
  - @tml/view@1.0.0

## 0.1.0

### Minor Changes

- 363cbbc: Add `tml init` for scaffolding starter config, plus release binaries and the install script.

### Patch Changes

- Updated dependencies [8374c04]
  - @tml/github@0.1.0
