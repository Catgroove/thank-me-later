# @tml/defaults

## 5.0.0

### Minor Changes

- bffb297: Add `--watch`: after the PR is ready, keep reconciling it (rebase, resolve conflicts, re-run CI) until it merges/closes or you quit.

  `--watch` is a thin loop of Re-entries (no daemon, no background process): each tick is a resume of the same Run that replays the cheap local prefix from the journal and re-runs only the PR-reconciling tail (`open-pr` → `ci-wait` → `merge-gate`). It defaults on in an interactive terminal and off without a TTY (so an agent or CI run is never pinned waiting for a human merge); `--watch` / `--no-watch` force it either way, and a `watch` / `watchInterval` knob in `tml.json` sets the default and cadence.

  Supporting changes: a new resumable `parked` run status and `park()` flow signal (a Run can now reach a clean, re-runnable rest instead of only `finished`); `merge-gate` detects a landed PR (merged/closed) and, under watch, parks once the PR is mergeable so the next tick reconciles it again.

### Patch Changes

- Updated dependencies [e9d8a4c]
- Updated dependencies [1cc55a9]
- Updated dependencies [bffb297]
  - @tml/core@0.5.0

## 4.0.1

### Patch Changes

- 0d29d94: Make review output readable instead of raw structured data. The agent's findings JSON no longer streams into the log: a schema run's text payload is suppressed at the harness (tool activity still streams), and the review pass logs a plain-English line of what it found and, on completion, a found-to-outcome overview (`N findings → M auto-fixed · K need your decision · J noted`). In the TUI, each finding leads with its title (severity badge and status glyph alongside, file:line and detail below) in both the findings tab and the approval drawer, the findings tab sorts by severity (worst first) and shows lifecycle status so you can tell what was fixed, and the PR-body review summary shows every finding with its lifecycle status so a reader can tell what was fixed and what still stands.

## 4.0.0

### Patch Changes

- fc374df: Lowercase the TUI labels to match the app's all-lowercase vibe. Review phase labels (`code review`, `apply fixes`), the findings-section and approval-drawer labels (`needs your decision`, `auto-fix`, `informational`, `approve as-is`, `skip this step`, `abort the run`, `fix selected findings`), the empty-state messages, and the key-help descriptions are now lowercase.
- Updated dependencies [b5b6f73]
  - @tml/core@0.4.0

## 3.0.0

### Minor Changes

- 2c74ebe: Remove the Step display layer. Steps no longer carry renderer metadata: the `StepDisplay` type and the `display` field on `Step`/`defineStep` are gone from `@tml/core`, the default pipeline drops its `display` labels, and `@tml/view` renders each Step by its `name`. The CLI and TUI now show the raw Step name (e.g. `open-pr`, `ci-wait`, `merge-gate`) instead of a pretty label, and the "PR gate" rail grouping is removed.

### Patch Changes

- Updated dependencies [2c74ebe]
  - @tml/core@0.3.0

## 2.0.0

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

- cfbf53d: Convert the default format, lint, typecheck, and test steps to core round loops with structured check findings, fresh fix rounds, verification rounds, and executor-managed fix commits.
- 49d5d49: Make the review step converge instead of churning:

  - Review asks a finishable question - bugs, risks, and safe non-functional simplifications in the changed code, nothing about styling/lint/types - and returns no findings when the change is clean. The open-ended "thermo-nuclear" restructuring mandate is gone.
  - Findings are triaged by action: only safe, mechanical issues are `auto-fix`; anything touching the author's intent (architecture, product behaviour) is `ask-user` and goes to the human approval gate, never looped on. Default is `ask-user` when in doubt.
  - Review does not re-review. It applies one fire-and-forget fix pass to the safe `auto-fix` findings and stops; it never runs a verify pass over its own judgement, so it cannot churn or re-surface findings you already decided on. The global `maxFixAttempts` now governs only the objective quality/test/ci checks, which converge by re-running their tool. A clean diff is one pass; obvious fixes cost one more; `ask-user` findings reach you once at the gate.

  Token cost is also cut: review no longer inlines the branch diff into every pass (it hands the agent the base ref and lets it read the worktree), round history fed to fresh agents is a compact, detail-free ledger, and the review preamble is a tight instruction block.

  BREAKING: the `--auto` ship flag and the auto-approval policy are removed. With review converging on its own, the human approval gate is the stopping point; auto-resolving it would auto-fix the `ask-user` findings that must reach a human. The `@tml/core` exports `autoApproveResponder`, `autoApproveFindings`, and `ApprovalDecisionSource`, and the `RoundRecord.approvalSource` field, are removed.

- 1d7fb72: Gate the ship on the PR being mergeable, and fix `ci-wait` falsely passing in a fraction of a second.

  `ci-wait` previously treated an empty status-check rollup as "all green" - but GitHub reports an empty rollup for the first seconds after a PR opens, before the workflow's check runs register, so the gate would settle instantly without ever waiting on CI. It now waits for checks to appear (a short grace window) before concluding a repo has no CI, applying the same guard on the initial wait that already protected the post-fix wait.

  Capture the host's overall merge-readiness verdict (`mergeStateStatus`) on `PullRequest` as a new `MergeState`, expose it through the required `getMergeState` provider capability, and add canonical merge-state classification helpers. A new `merge-gate` step runs last in the default pipeline: after CI is green it polls the host until the merge state settles and surfaces a finding when the PR is behind its base, conflicted, blocked by branch protection, or still a draft - keeping that gate distinct from CI, which `merge-gate` deliberately does not re-derive from the merge state. Disable it with `disable: ["merge-gate"]` in `tml.json`.

  The merge state reflects the branch rule, not the viewer's privileges, so a maintainer who can bypass a ruleset still sees `blocked`. To avoid nagging them, the gate is bypass-aware: for states a bypass actor could merge through (`blocked`, `behind`) it consults the new optional `canBypassMerge` provider capability and passes when the current user may bypass. States no permission can clear - a `dirty` conflict or a `draft` - still surface. The GitHub provider implements `canBypassMerge` by matching the base branch's active rules to their rulesets and reading `current_user_can_bypass`.

- 1ce2958: Make the PR body the base audit surface: expose completed rounds to Steps, add generic round summary renderers, and have the default open-pr Step create or refresh a delimited generated summary block instead of using PR comments or review threads.
- fc5b5d3: Re-sync onto the latest base as part of `open-pr` before pushing the branch. The default pipeline now
  keeps the final publish-time base sync but no longer exposes it as a separate `resync` step, reducing
  pipeline noise while ensuring the PR opens and CI starts from a freshly fetched base when the base
  moves during checks or review.
- ae29294: Run the default review step before the quality and test gates so review fixes are verified before the PR is opened.
- 77ac03a: Convert the default review step to the core round executor, with fresh verification passes and executor-managed review fix commits.
- ef44a8d: Replace the multi-pass default review flow with one Cursor-style thermo-nuclear maintainability review pass, while keeping the existing safe auto-fix round loop.

### Patch Changes

- bbe9356: Replace cross-round finding-id stall detection with agent-owned verification, a no-progress stop when fixes produce no commit, and a configurable `maxFixAttempts` `tml.json` knob.
- 7a7f09b: Represent blocking review verdicts as metadata on concrete findings instead of adding a separate selectable approval finding.
- b82db55: Add round-based CI auto-fix with failed check log retrieval for GitHub, plus structured local approval gates for default check and review findings.
- 7d7a72d: Combine the default format, lint, and typecheck gates into one quality step. The step keeps source-inspection checks for formatting and lint while running the real typecheck command, and removes the old separate prompt and step factories.
- 30a20ba: Move the agent-findings validator into `@tml/core`, beside `makeFinding` and `findingId` where Findings are minted. `parseAgentFindingsOutput` (and `ParseAgentFindingsOptions`) are now part of core's public surface; the check and review steps import them from `@tml/core` and the standalone `findings` module in `@tml/defaults` is deleted. Finding validity - the severity and action enum tables - no longer leaks out of core.
- e93c574: Refactor default pipeline helpers to reuse shared finding parsing, worktree-guard, and round-summary logic.
- 82ea0a4: Classify findings by disposition instead of compiler-style severity. A finding now carries
  `disposition: "blocker" | "should-fix" | "consider" | "nit"` in place of the old
  `severity: "error" | "warning" | "info"`, and the separate `blocking` flag is gone - `blocker`
  subsumes it. Disposition states how strongly tml recommends acting, which is what a human
  triaging the approval gate actually needs, and the action constraint follows it: `blocker` and
  `should-fix` findings must be auto-fix or ask-user, while `consider` and `nit` may use any
  action. Review and check prompts, the PR risk summary, and the TUI labels/colors all speak the
  new vocabulary.
- 1085512: Fold the final publish-time base sync into `open-pr` so the default pipeline keeps opening PRs from a freshly fetched base without exposing a separate `resync` step.
- 4f593a7: Merge the approval gate into the Round loop. `executeRoundLoop` now handles its own approval escalation: when a check stops needing a user and the Step supplies a `stepName`, the loop routes the findings through `ctx.approveFindings` inline, continuing with an operator fix or ending on approve/skip/abort. This deletes the separate `approval-gate` module and the loop's re-entry options (`initialRounds`, `initialAttempts`, `initialFixFindings`); Steps call `executeRoundLoop` directly.
- fd65104: Run the default format and lint gates as model-backed source inspection instead of invoking repository quality toolchains during check rounds. Checks now carry an explicit inspect/run mode, so a gate that must execute its toolchain (typecheck, test) opts into running its command while format and lint stay read-only.
- 45fa664: Add observable Step phases: expose `Ctx.phase` and phase `RunEvent`s in `@tml/core`, have default review passes report phase spans, and render those spans and phase findings in TUI views.
- edad77f: Add generic Step display metadata and use it to group the default CI and merge readiness steps under a shared PR gate label in terminal and TUI presentation.
- 59e6b03: Show human-friendly labels for the bundled pipeline steps while keeping their stable step names for config and resume behavior.
- 6b227d1: Inject deterministic diffs into default review passes, feed prior test-step results into correctness review, deduplicate overlapping review findings, and replace the nit-focused lens with a precision-first structural review.
- c209d54: Rename the code-host provider concept to Git provider across the public API and config. The new names are `ctx.gitProvider`, `providers.gitProvider`, `Selection.gitProvider`, `registerGitProvider`, `GitProvider`, and `createGitHubProvider`.
- 060cf35: Separate isolated workspace branch state from auto-resume selection, emit explicit run pause events, and align default check cleanup with check mode policies.
- c065c58: Make review approvals fix the operator's visible finding selection, record review rounds live, and correlate phase events with stable span ids.
- 6b227d1: Parallelize post-context review passes, keep Git diffs presentation-neutral, route blocking review verdicts through the approval gate, and reject inconsistent review finding severity/action pairs.
- e3a1b4d: Make review and check fix commits use per-round summaries, and render PR bodies with deterministic round narratives plus accepted/skipped finding state.
- b8adcbb: Introduce shared Finding and RoundRecord records, deterministic finding IDs, journaled completed rounds, and PR-summary render helpers for review, checks, and CI.
- 060cf35: Simplify internals across packages: collapse the single-pass `ReviewPass` machinery to a flat
  `Finding[]` flow, remove the unused `fixedFindingIds` summary branch (the review summary now tallies
  unresolved auto-fixes rather than ever marking them "(fixed)"), share one git-spawn helper, dedup the
  findings-schema envelope and the "no prior rounds" sentinel, and consolidate the TUI finding-section
  model, severity colors, and finding marker.

  User-visible: the approval drawer's auto-fix section is now labelled "Auto-fix" (was "Auto-fix next
  round"). `@tml/core` adds `hasPriorRounds` and drops `renderRoundForPr`/`renderRoundForPrompt` from
  its public surface (use the `renderRounds*` forms); `@tml/view` no longer re-exports the secondary
  fold view types (`StepView`, `ArtifactView`, `ToolView`, `PendingInteraction`, `ActivityEntry`).

- 82ea0a4: Make the typecheck step run the real type checker instead of simulating it. The prompt
  previously forbade invoking the compiler and asked the agent to verify types by model-backed
  source inspection, which crawled the whole diff and took minutes. It now discovers the
  project's type-check command and runs it - fast and authoritative - matching how the test
  step already works. Format and lint remain source-inspection checks.
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
