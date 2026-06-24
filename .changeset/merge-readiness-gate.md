---
"@tml/core": minor
"@tml/github": minor
"@tml/defaults": minor
---

Gate the ship on the PR being mergeable, and fix `ci-wait` falsely passing in a fraction of a second.

`ci-wait` previously treated an empty status-check rollup as "all green" - but GitHub reports an empty rollup for the first seconds after a PR opens, before the workflow's check runs register, so the gate would settle instantly without ever waiting on CI. It now waits for checks to appear (a short grace window) before concluding a repo has no CI, applying the same guard on the initial wait that already protected the post-fix wait.

Capture the host's overall merge-readiness verdict (`mergeStateStatus`) on `PullRequest` as a new `MergeState`, expose it through the required `getMergeState` provider capability, and add canonical merge-state classification helpers. A new `merge-gate` step runs last in the default pipeline: after CI is green it polls the host until the merge state settles and surfaces a finding when the PR is behind its base, conflicted, blocked by branch protection, or still a draft - keeping that gate distinct from CI, which `merge-gate` deliberately does not re-derive from the merge state. Disable it with `disable: ["merge-gate"]` in `tml.json`.

The merge state reflects the branch rule, not the viewer's privileges, so a maintainer who can bypass a ruleset still sees `blocked`. To avoid nagging them, the gate is bypass-aware: for states a bypass actor could merge through (`blocked`, `behind`) it consults the new optional `canBypassMerge` provider capability and passes when the current user may bypass. States no permission can clear - a `dirty` conflict or a `draft` - still surface. The GitHub provider implements `canBypassMerge` by matching the base branch's active rules to their rulesets and reading `current_user_can_bypass`.
