# @tml/core

## 0.1.0

### Minor Changes

- cafb140: Enforce the read-only contract of the review passes. The five review passes are described as
  read-only but run against an edit-capable harness, so a misbehaving pass could modify the
  worktree and have those edits committed by the trailing `commit(review)` — misattributed to the
  fix pass. The `review` step now snapshots the worktree before the passes and reverts any
  modifications they make before the fix pass runs, with a warning. Adds a `discardChanges()`
  method to the `Git` provider in `@tml/core` (discards all uncommitted changes, returning the
  worktree to `HEAD`).
- d7ae10f: Add a `rebase` step to the default pipeline. After the change is committed, tml rebases onto the
  freshly fetched default branch so the checks, review, and CI all run against the current base. It
  skips when there's nothing to do, asks the agent to resolve conflicts (aborting back to a pristine
  branch and deferring to you if it can't), and cancels the run when the work has already landed
  upstream. `open-pr` now force-pushes with `--force-with-lease` to carry the rewritten history
  safely. Disable it with `disable: ["rebase"]` in `tml.json`.
