# @tml/github

## 2.0.0

### Major Changes

- c209d54: Rename the code-host provider concept to Git provider across the public API and config. The new names are `ctx.gitProvider`, `providers.gitProvider`, `Selection.gitProvider`, `registerGitProvider`, `GitProvider`, and `createGitHubProvider`.

### Minor Changes

- e18a90a: Harden the base PR/CI GitProvider surface: keep PullRequest focused on PR metadata, mergeability, and checks; add PR body updates, optional mergeability polling, and optional failed-check-log retrieval; and keep review-thread/comment state out of the base provider contract.
- 1d7fb72: Gate the ship on the PR being mergeable, and fix `ci-wait` falsely passing in a fraction of a second.

  `ci-wait` previously treated an empty status-check rollup as "all green" - but GitHub reports an empty rollup for the first seconds after a PR opens, before the workflow's check runs register, so the gate would settle instantly without ever waiting on CI. It now waits for checks to appear (a short grace window) before concluding a repo has no CI, applying the same guard on the initial wait that already protected the post-fix wait.

  Capture the host's overall merge-readiness verdict (`mergeStateStatus`) on `PullRequest` as a new `MergeState`, expose it through the required `getMergeState` provider capability, and add canonical merge-state classification helpers. A new `merge-gate` step runs last in the default pipeline: after CI is green it polls the host until the merge state settles and surfaces a finding when the PR is behind its base, conflicted, blocked by branch protection, or still a draft - keeping that gate distinct from CI, which `merge-gate` deliberately does not re-derive from the merge state. Disable it with `disable: ["merge-gate"]` in `tml.json`.

  The merge state reflects the branch rule, not the viewer's privileges, so a maintainer who can bypass a ruleset still sees `blocked`. To avoid nagging them, the gate is bypass-aware: for states a bypass actor could merge through (`blocked`, `behind`) it consults the new optional `canBypassMerge` provider capability and passes when the current user may bypass. States no permission can clear - a `dirty` conflict or a `draft` - still surface. The GitHub provider implements `canBypassMerge` by matching the base branch's active rules to their rulesets and reading `current_user_can_bypass`.

### Patch Changes

- b82db55: Add round-based CI auto-fix with failed check log retrieval for GitHub, plus structured local approval gates for default check and review findings.
- 236a193: Use high-level `gh pr view --json` output instead of hand-written GraphQL for GitHub PR snapshots and check polling.
- Updated dependencies [a7ad94a]
- Updated dependencies [bbe9356]
- Updated dependencies [5b299f9]
- Updated dependencies [e18a90a]
- Updated dependencies [7a7f09b]
- Updated dependencies [060cf35]
- Updated dependencies [b82db55]
- Updated dependencies [30a20ba]
- Updated dependencies [49d5d49]
- Updated dependencies [6a2f301]
- Updated dependencies [82ea0a4]
- Updated dependencies [2958361]
- Updated dependencies [fdd146c]
- Updated dependencies [e603844]
- Updated dependencies [a9f93ca]
- Updated dependencies [4f593a7]
- Updated dependencies [1d7fb72]
- Updated dependencies [45fa664]
- Updated dependencies [e4a711f]
- Updated dependencies [a9f93ca]
- Updated dependencies [1ce2958]
- Updated dependencies [edad77f]
- Updated dependencies [6b227d1]
- Updated dependencies [c209d54]
- Updated dependencies [060cf35]
- Updated dependencies [577b729]
- Updated dependencies [c065c58]
- Updated dependencies [6b227d1]
- Updated dependencies [1c6baf3]
- Updated dependencies [728abc0]
- Updated dependencies [e3a1b4d]
- Updated dependencies [b8adcbb]
- Updated dependencies [060cf35]
- Updated dependencies [c332844]
- Updated dependencies [dcf7534]
- Updated dependencies [2f7c7a8]
  - @tml/core@0.2.0

## 1.0.0

### Patch Changes

- Updated dependencies [cafb140]
- Updated dependencies [d7ae10f]
  - @tml/core@0.1.0

## 0.1.0

### Minor Changes

- 8374c04: Implement the GitHub Forge provider. `createGitHubForge(cwd)` satisfies core's `Forge`
  by shelling out to the `gh` CLI (which owns auth + repo detection): `findPullRequest`
  (the ADR-0004 idempotency hook), `openPullRequest`, `getPullRequest`, and a pollable
  `getChecks`. A pure mapping layer maps `gh` GraphQL JSON onto the canonical lifecycle
  entities; the suite is hermetic via an injectable `GhRunner`, with an opt-in live smoke
  behind `TML_GH_LIVE=1`.
