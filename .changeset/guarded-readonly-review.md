---
"@tml/core": minor
"@tml/defaults": patch
---

Enforce the read-only contract of the review passes. The five review passes are described as
read-only but run against an edit-capable harness, so a misbehaving pass could modify the
worktree and have those edits committed by the trailing `commit(review)` — misattributed to the
fix pass. The `review` step now snapshots the worktree before the passes and reverts any
modifications they make before the fix pass runs, with a warning. Adds a `discardChanges()`
method to the `Git` provider in `@tml/core` (discards all uncommitted changes, returning the
worktree to `HEAD`).
