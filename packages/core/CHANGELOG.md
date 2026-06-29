# @tml/core

## 0.5.0

### Minor Changes

- e9d8a4c: Run history, the run picker, the viewer, and a guided startup gate. `tml runs` (alias `tml ls`)
  lists the recent runs for a checkout - a picker in a TTY, a plain table when piped - and `tml runs
<id>` views a finished run or attaches to one still running, read-only. A bare `tml` on an
  interactive TTY now consults run history first: when an unfinished run for the current branch
  exists, it offers resume / attach / fresh / list instead of silently starting over (a non-TTY/CI
  run, `--plain`, or an explicit `--fresh`/`--resume` skips the gate). Runs record their PR URL,
  finish time, failure summary, and owning process, and a run still marked `running` is classified by
  liveness so a crash orphan reads as resumable rather than a phantom in progress.
- 1cc55a9: Add `tml stats`: a lifetime view of the pipeline across journaled runs. It rolls up every checkout (`--here` narrows to the current one), folding all clones and worktrees of a repo into one row by their git remote, and reports it in tml's own visual language - the `▶`/`─` run header, the finding-lifecycle glyph tally (`✓` fixed/accepted, `✗` unresolved, `⤼` skipped, `○` open), the `▸` pipeline rail with per-step seen/fixed, and `[disposition]` severity markers. `--json` emits the raw figures.

  Core gains `readRunHistory` and `summarizeRunStats`; view gains `renderStats`.

- bffb297: Add `--watch`: after the PR is ready, keep reconciling it (rebase, resolve conflicts, re-run CI) until it merges/closes or you quit.

  `--watch` is a thin loop of Re-entries (no daemon, no background process): each tick is a resume of the same Run that replays the cheap local prefix from the journal and re-runs only the PR-reconciling tail (`open-pr` → `ci-wait` → `merge-gate`). It defaults on in an interactive terminal and off without a TTY (so an agent or CI run is never pinned waiting for a human merge); `--watch` / `--no-watch` force it either way, and a `watch` / `watchInterval` knob in `tml.json` sets the default and cadence.

  Supporting changes: a new resumable `parked` run status and `park()` flow signal (a Run can now reach a clean, re-runnable rest instead of only `finished`); `merge-gate` detects a landed PR (merged/closed) and, under watch, parks once the PR is mergeable so the next tick reconciles it again.

## 0.4.0

### Minor Changes

- b5b6f73: Expose harness discovery APIs: core now exports registered harness inspection and optional harness detection metadata, and the pi harness exposes configurable binary resolution for detection.

## 0.3.0

### Minor Changes

- 2c74ebe: Remove the Step display layer. Steps no longer carry renderer metadata: the `StepDisplay` type and the `display` field on `Step`/`defineStep` are gone from `@tml/core`, the default pipeline drops its `display` labels, and `@tml/view` renders each Step by its `name`. The CLI and TUI now show the raw Step name (e.g. `open-pr`, `ci-wait`, `merge-gate`) instead of a pretty label, and the "PR gate" rail grouping is removed.

## 0.2.0

### Minor Changes

- e18a90a: Harden the base PR/CI GitProvider surface: keep PullRequest focused on PR metadata, mergeability, and checks; add PR body updates, optional mergeability polling, and optional failed-check-log retrieval; and keep review-thread/comment state out of the base provider contract.
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

- 2958361: Derive a per-finding lifecycle so the Findings tab reads as a checklist that checks itself off. `@tml/core` adds `findingLifecycle`, `FindingStatus`, `FindingLifecycle`, and a `RoundResolution` marker recorded on the terminal round of an approval gate. The TUI Findings tab now shows the cumulative set across the whole round history - findings selected for fix show `pending`, a verified fix shows `fixed`, and an operator decision shows `accepted as-is`/`skipped` - instead of silently dropping resolved findings.
- e603844: Run `tml ship` in an isolated snapshot workspace by default so source checkout edits, ignored files, and review resets do not interfere with active runs.
- 1d7fb72: Gate the ship on the PR being mergeable, and fix `ci-wait` falsely passing in a fraction of a second.

  `ci-wait` previously treated an empty status-check rollup as "all green" - but GitHub reports an empty rollup for the first seconds after a PR opens, before the workflow's check runs register, so the gate would settle instantly without ever waiting on CI. It now waits for checks to appear (a short grace window) before concluding a repo has no CI, applying the same guard on the initial wait that already protected the post-fix wait.

  Capture the host's overall merge-readiness verdict (`mergeStateStatus`) on `PullRequest` as a new `MergeState`, expose it through the required `getMergeState` provider capability, and add canonical merge-state classification helpers. A new `merge-gate` step runs last in the default pipeline: after CI is green it polls the host until the merge state settles and surfaces a finding when the PR is behind its base, conflicted, blocked by branch protection, or still a draft - keeping that gate distinct from CI, which `merge-gate` deliberately does not re-derive from the merge state. Disable it with `disable: ["merge-gate"]` in `tml.json`.

  The merge state reflects the branch rule, not the viewer's privileges, so a maintainer who can bypass a ruleset still sees `blocked`. To avoid nagging them, the gate is bypass-aware: for states a bypass actor could merge through (`blocked`, `behind`) it consults the new optional `canBypassMerge` provider capability and passes when the current user may bypass. States no permission can clear - a `dirty` conflict or a `draft` - still surface. The GitHub provider implements `canBypassMerge` by matching the base branch's active rules to their rulesets and reading `current_user_can_bypass`.

- 45fa664: Add observable Step phases: expose `Ctx.phase` and phase `RunEvent`s in `@tml/core`, have default review passes report phase spans, and render those spans and phase findings in TUI views.
- a9f93ca: Add a full-screen OpenTUI/Solid TUI as the default interactive presentation for `tml ship`. A TTY now opens an alternate-screen dashboard - an ordered Pipeline rail, a generic per-Step inspector (Summary, Artifacts, Findings, Rounds), and an always-visible activity panel that follows the full cross-Step trail - and resolves `ctx.ask`/`ctx.approveFindings` through inline drawers. `--plain`/`--no-tui` and non-TTY output keep the existing append-only renderer. Every `RunEvent` now carries an `at` timestamp and the engine emits `round:recorded`, so completed durations and Finding/Round data come from structured events rather than renderer-local guesses. The TUI is Pipeline-generic: it makes no assumptions about the default Step names.
- 1ce2958: Make the PR body the base audit surface: expose completed rounds to Steps, add generic round summary renderers, and have the default open-pr Step create or refresh a delimited generated summary block instead of using PR comments or review threads.
- c209d54: Rename the code-host provider concept to Git provider across the public API and config. The new names are `ctx.gitProvider`, `providers.gitProvider`, `Selection.gitProvider`, `registerGitProvider`, `GitProvider`, and `createGitHubProvider`.
- 1c6baf3: Add a reusable round executor for fresh check, fix, commit, and verification loops.
- b8adcbb: Introduce shared Finding and RoundRecord records, deterministic finding IDs, journaled completed rounds, and PR-summary render helpers for review, checks, and CI.
- dcf7534: Tidy core primitives: expose flow signal constructors on the injected Plugin API, remove unused public approval/error exports, simplify the event queue, use native abortable timers, and parse Git status with NUL-delimited porcelain output.

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
- 7a7f09b: Represent blocking review verdicts as metadata on concrete findings instead of adding a separate selectable approval finding.
- b82db55: Add round-based CI auto-fix with failed check log retrieval for GitHub, plus structured local approval gates for default check and review findings.
- 30a20ba: Move the agent-findings validator into `@tml/core`, beside `makeFinding` and `findingId` where Findings are minted. `parseAgentFindingsOutput` (and `ParseAgentFindingsOptions`) are now part of core's public surface; the check and review steps import them from `@tml/core` and the standalone `findings` module in `@tml/defaults` is deleted. Finding validity - the severity and action enum tables - no longer leaks out of core.
- 6a2f301: Add a file-backed Run Journal that persists local run metadata, completed steps, artifacts, agent rounds, and optional events for crash/resume foundations.
- 82ea0a4: Classify findings by disposition instead of compiler-style severity. A finding now carries
  `disposition: "blocker" | "should-fix" | "consider" | "nit"` in place of the old
  `severity: "error" | "warning" | "info"`, and the separate `blocking` flag is gone - `blocker`
  subsumes it. Disposition states how strongly tml recommends acting, which is what a human
  triaging the approval gate actually needs, and the action constraint follows it: `blocker` and
  `should-fix` findings must be auto-fix or ask-user, while `consider` and `nit` may use any
  action. Review and check prompts, the PR risk summary, and the TUI labels/colors all speak the
  new vocabulary.
- fdd146c: Document that every Harness run executes one isolated agent task and must not continue prior conversational state.
- a9f93ca: Scope `auto` Run Journal resume to the git branch you're on. Previously `tml ship` resumed the latest unfinished journal run for the checkout whenever the pipeline matched, so a fresh ship from the default branch replayed a prior shipment's completed Steps - skipping branch creation, commit, and the local checks, and re-pushing a stale feature branch (which then failed `--force-with-lease`). Runs now record a `resumeKey` (the branch they're shipping, advanced to the feature branch once one is cut), and `auto` resume only continues a parked run whose branch matches the one you're on. A fresh ship from the default branch now starts clean; re-running on the feature branch still resumes. Legacy keyless journals remain resumable from a keyless start.
- 4f593a7: Merge the approval gate into the Round loop. `executeRoundLoop` now handles its own approval escalation: when a check stops needing a user and the Step supplies a `stepName`, the loop routes the findings through `ctx.approveFindings` inline, continuing with an operator fix or ending on approve/skip/abort. This deletes the separate `approval-gate` module and the loop's re-entry options (`initialRounds`, `initialAttempts`, `initialFixFindings`); Steps call `executeRoundLoop` directly.
- e4a711f: Move the round-history prompt renderer out of the round executor into `round.ts` as the exported `renderRoundsForPrompt` (with a `renderRoundForPrompt` per-round helper), alongside the existing PR-summary renderer. All `RoundRecord`-to-text rendering now lives in one module, and the executor calls the shared renderer for both fresh-agent history and approval-gate context.
- edad77f: Add generic Step display metadata and use it to group the default CI and merge readiness steps under a shared PR gate label in terminal and TUI presentation.
- 6b227d1: Inject deterministic diffs into default review passes, feed prior test-step results into correctness review, deduplicate overlapping review findings, and replace the nit-focused lens with a precision-first structural review.
- 060cf35: Separate isolated workspace branch state from auto-resume selection, emit explicit run pause events, and align default check cleanup with check mode policies.
- 577b729: Replay a resumed Step's artifacts and Round history into the view. When `tml ship` resumes a Run Journal and skips an already-completed Step, the engine now re-emits the durable facts (`artifact:written`, `round:recorded`) it loaded from the journal before marking the Step skipped. Previously a skipped Step rendered empty - the summary, artifacts, and Findings were persisted and rehydrated for execution but never turned into the presentation events the event-sourced view folds, so the TUI/CLI showed only "skipped" with no record of what the prior run did. The Step still reports `skipped`; it now carries its prior output.
- c065c58: Make review approvals fix the operator's visible finding selection, record review rounds live, and correlate phase events with stable span ids.
- 6b227d1: Parallelize post-context review passes, keep Git diffs presentation-neutral, route blocking review verdicts through the approval gate, and reject inconsistent review finding severity/action pairs.
- 728abc0: Stop the review/fix loop from re-running a fix that changes nothing. A verify round that
  reproduces the previous check's exact findings is now treated as stalled and escalates to the
  approval gate (or proceeds, when no gate is configured) instead of burning another identical
  round. Operator-driven fixes remain uncapped by design - the human stays in control - but a
  stalled gate now says so explicitly.

  The step inspector's rounds tab also numbers the fix attempts (`fix 1`, `fix 2`, ...) next to
  the raw round index, so "round 5" is legible as the third fix rather than an opaque counter.

- e3a1b4d: Make review and check fix commits use per-round summaries, and render PR bodies with deterministic round narratives plus accepted/skipped finding state.
- 060cf35: Simplify internals across packages: collapse the single-pass `ReviewPass` machinery to a flat
  `Finding[]` flow, remove the unused `fixedFindingIds` summary branch (the review summary now tallies
  unresolved auto-fixes rather than ever marking them "(fixed)"), share one git-spawn helper, dedup the
  findings-schema envelope and the "no prior rounds" sentinel, and consolidate the TUI finding-section
  model, severity colors, and finding marker.

  User-visible: the approval drawer's auto-fix section is now labelled "Auto-fix" (was "Auto-fix next
  round"). `@tml/core` adds `hasPriorRounds` and drops `renderRoundForPr`/`renderRoundForPrompt` from
  its public surface (use the `renderRounds*` forms); `@tml/view` no longer re-exports the secondary
  fold view types (`StepView`, `ArtifactView`, `ToolView`, `PendingInteraction`, `ActivityEntry`).

- c332844: Add the structured finding approval primitive and render its pending event.
- 2f7c7a8: Show the active branch in the TUI header. The engine now emits a `branch:changed` event from its
  own git view of the checkout - at Run start (so a resumed run in an isolated worktree shows the
  feature branch immediately) and whenever a Step advances HEAD onto a different branch. The presenter
  folds it into `ViewState.currentBranch`, and the TUI header renders a middle-truncated `⎇ <branch>`
  segment. It tracks core's branch reading, not any pipeline's branch-name artifact, so it stays
  accurate for custom pipelines.

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
