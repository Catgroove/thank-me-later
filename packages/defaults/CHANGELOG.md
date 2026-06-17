# @tml/defaults

## 1.0.0

### Minor Changes

- cafb140: Make `review` an extensive, staff-engineer-style review. The single-shot review step is
  replaced by five focused read-only passes — context & intent, architecture & scope (a "drop
  everything and reject" gate), correctness & testing, design & non-functional, and
  maintainability & micro (a guardrailed over-engineering sweep) — followed by one fix pass that
  applies only the safe `auto-fix` findings. The PR's review summary is now richer markdown: a
  deterministic overall risk level, severity-labelled findings (`Critical:`/`Warning:`/`Nit:`)
  grouped by phase, and the fixes applied. A blocking architecture verdict is surfaced as a
  high-risk banner for the human at merge time (it does not halt the run). `ask-user` findings are
  listed for the human and never auto-applied.
- d7ae10f: Add a `rebase` step to the default pipeline. After the change is committed, tml rebases onto the
  freshly fetched default branch so the checks, review, and CI all run against the current base. It
  skips when there's nothing to do, asks the agent to resolve conflicts (aborting back to a pristine
  branch and deferring to you if it can't), and cancels the run when the work has already landed
  upstream. `open-pr` now force-pushes with `--force-with-lease` to carry the rewritten history
  safely. Disable it with `disable: ["rebase"]` in `tml.json`.

### Patch Changes

- cafb140: Reject malformed review verdicts and keep blocking summaries internally consistent. The
  architecture pass now uses a schema that requires an explicit `verdict`, so the block gate can
  no longer silently downgrade to a non-blocking summary when the agent omits it.
- cafb140: Enforce the read-only contract of the review passes. The five review passes are described as
  read-only but run against an edit-capable harness, so a misbehaving pass could modify the
  worktree and have those edits committed by the trailing `commit(review)` — misattributed to the
  fix pass. The `review` step now snapshots the worktree before the passes and reverts any
  modifications they make before the fix pass runs, with a warning. Adds a `discardChanges()`
  method to the `Git` provider in `@tml/core` (discards all uncommitted changes, returning the
  worktree to `HEAD`).
- Updated dependencies [cafb140]
- Updated dependencies [d7ae10f]
  - @tml/core@0.1.0
