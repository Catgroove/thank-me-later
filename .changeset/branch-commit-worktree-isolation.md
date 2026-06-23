---
"@tml/core": minor
"@tml/defaults": minor
"tml": minor
---

Isolate `tml ship` runs with a branch -> commit -> worktree model. `branch`, `describe`, and
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
