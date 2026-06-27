# @tml/view

## 3.0.0

### Major Changes

- 2c74ebe: Remove the Step display layer. Steps no longer carry renderer metadata: the `StepDisplay` type and the `display` field on `Step`/`defineStep` are gone from `@tml/core`, the default pipeline drops its `display` labels, and `@tml/view` renders each Step by its `name`. The CLI and TUI now show the raw Step name (e.g. `open-pr`, `ci-wait`, `merge-gate`) instead of a pretty label, and the "PR gate" rail grouping is removed.

### Patch Changes

- 93dafcb: Make running the pipeline the default command: `tml` (no subcommand) now runs the pipeline on the current checkout, with all the former ship options (`--verbose`, `--plain`, `--resume`, `--fresh`). `tml ship` keeps working as an alias but is no longer required or advertised - the help text and the TUI banner now read `tml`.
- a2b94ef: Add an `openInBrowser` knob to `tml.json` (default `false`). When set, `tml ship` opens the run's PR in your default browser when the run finishes or fails after opening one - the same action as pressing `o` in the TUI - so a hands-off run still surfaces the PR. It is best set in your global `~/.config/tml/tml.json`. The browser-opener is now shared (`openSystemUrl`, exported from `@tml/view`) by both the TUI keybind and the CLI lifecycle.
- Updated dependencies [2c74ebe]
  - @tml/core@0.3.0

## 2.0.0

### Major Changes

- 060cf35: Simplify internals across packages: collapse the single-pass `ReviewPass` machinery to a flat
  `Finding[]` flow, remove the unused `fixedFindingIds` summary branch (the review summary now tallies
  unresolved auto-fixes rather than ever marking them "(fixed)"), share one git-spawn helper, dedup the
  findings-schema envelope and the "no prior rounds" sentinel, and consolidate the TUI finding-section
  model, severity colors, and finding marker.

  User-visible: the approval drawer's auto-fix section is now labelled "Auto-fix" (was "Auto-fix next
  round"). `@tml/core` adds `hasPriorRounds` and drops `renderRoundForPr`/`renderRoundForPrompt` from
  its public surface (use the `renderRounds*` forms); `@tml/view` no longer re-exports the secondary
  fold view types (`StepView`, `ArtifactView`, `ToolView`, `PendingInteraction`, `ActivityEntry`).

### Minor Changes

- a9f93ca: Add a full-screen OpenTUI/Solid TUI as the default interactive presentation for `tml ship`. A TTY now opens an alternate-screen dashboard - an ordered Pipeline rail, a generic per-Step inspector (Summary, Artifacts, Findings, Rounds), and an always-visible activity panel that follows the full cross-Step trail - and resolves `ctx.ask`/`ctx.approveFindings` through inline drawers. `--plain`/`--no-tui` and non-TTY output keep the existing append-only renderer. Every `RunEvent` now carries an `at` timestamp and the engine emits `round:recorded`, so completed durations and Finding/Round data come from structured events rather than renderer-local guesses. The TUI is Pipeline-generic: it makes no assumptions about the default Step names.
- fc5b5d3: Keep the full-screen TUI up when the pipeline finishes instead of tearing it down the instant the run
  ends. After a finished (or failed) run the dashboard stays interactive - the pipeline rail, inspector,
  and activity panel remain navigable - with a banner showing the outcome and the PR link, and leaves
  only when the user presses `q`/`enter`/`esc`. `@tml/view` adds an optional renderer `complete()`
  hook for post-run lifecycle policy; the TUI uses it to wait before teardown. Plain/non-TTY renderers
  omit it, so CI and piped runs still return the moment the run ends. A user-driven cancel still exits
  at once.

### Patch Changes

- c24c726: Group the approval drawer's findings by action - "Needs your decision" (ask-user), "Auto-fix next round", and "Informational" - each with its own icon, accent color, and header count, mirroring the inspector's findings tab. Finding rows now color by severity and drop the redundant per-row action tag, and keyboard navigation walks the same section order so the focus highlight always lines up.
- 5b299f9: Add `tml ship --auto` for non-interactive finding gates with bounded auto-fix behavior and blocker-safe aborts.
- 7a7f09b: Represent blocking review verdicts as metadata on concrete findings instead of adding a separate selectable approval finding.
- b82db55: Add round-based CI auto-fix with failed check log retrieval for GitHub, plus structured local approval gates for default check and review findings.
- bd11587: Collapse the CLI and plain terminal renderers into one output module (`createTerminalRenderer`) that selects live (TTY) or append-only mechanics internally, so artifact, prompt, and results rules live in one place instead of being copied per renderer.
- 1ab80df: Stop a Step's elapsed time from advancing while the Run is blocked on a human decision (an `ask`/`approval` gate). The presenter now tracks per-Step `waitedMs` and excludes it from the recorded `durationMs`; live elapsed in the TUI and the sealed timing in the terminal renderer freeze at the moment the gate opens. A review awaiting approval no longer shows a clock that climbs while the user deliberates.
- 82ea0a4: Classify findings by disposition instead of compiler-style severity. A finding now carries
  `disposition: "blocker" | "should-fix" | "consider" | "nit"` in place of the old
  `severity: "error" | "warning" | "info"`, and the separate `blocking` flag is gone - `blocker`
  subsumes it. Disposition states how strongly tml recommends acting, which is what a human
  triaging the approval gate actually needs, and the action constraint follows it: `blocker` and
  `should-fix` findings must be auto-fix or ask-user, while `consider` and `nit` may use any
  action. Review and check prompts, the PR risk summary, and the TUI labels/colors all speak the
  new vocabulary.
- 2958361: Derive a per-finding lifecycle so the Findings tab reads as a checklist that checks itself off. `@tml/core` adds `findingLifecycle`, `FindingStatus`, `FindingLifecycle`, and a `RoundResolution` marker recorded on the terminal round of an approval gate. The TUI Findings tab now shows the cumulative set across the whole round history - findings selected for fix show `pending`, a verified fix shows `fixed`, and an operator decision shows `accepted as-is`/`skipped` - instead of silently dropping resolved findings.
- 66cac4a: Group the inspector's findings tab by action - "Needs your decision" (ask-user), "Auto-fix", and "Informational" - so what needs the user is separated from what the pipeline handles, and auto-focus that tab onto the Step under decision the moment an approval gate opens.
- 4ebf457: Highlight the focused finding in the Step inspector's Findings tab while an approval is pending, so the detailed finding stays visually linked to the row the operator is on in the approval action list.
- 45fa664: Add observable Step phases: expose `Ctx.phase` and phase `RunEvent`s in `@tml/core`, have default review passes report phase spans, and render those spans and phase findings in TUI views.
- edad77f: Add generic Step display metadata and use it to group the default CI and merge readiness steps under a shared PR gate label in terminal and TUI presentation.
- 10da889: Copy TUI mouse selections with y or cmd-c.
- f740d49: Keep transient activity and empty-state placeholders out of the TUI summary pane.
- 252b0ea: Size the TUI pipeline rail to its content: it now grows to fit the longest Step name (and an active Step's Phase labels) within a fixed width band, instead of a hardcoded 30 columns, so longer names and their elapsed times no longer collide.
- 060cf35: Separate isolated workspace branch state from auto-resume selection, emit explicit run pause events, and align default check cleanup with check mode policies.
- c065c58: Make review approvals fix the operator's visible finding selection, record review rounds live, and correlate phase events with stable span ids.
- 728abc0: Stop the review/fix loop from re-running a fix that changes nothing. A verify round that
  reproduces the previous check's exact findings is now treated as stalled and escalates to the
  approval gate (or proceeds, when no gate is configured) instead of burning another identical
  round. Operator-driven fixes remain uncapped by design - the human stays in control - but a
  stalled gate now says so explicitly.

  The step inspector's rounds tab also numbers the fix attempts (`fix 1`, `fix 2`, ...) next to
  the raw round index, so "round 5" is legible as the third fix rather than an opaque counter.

- c332844: Add the structured finding approval primitive and render its pending event.
- 3be5d19: Show total elapsed time in the TUI header and per-phase elapsed timers for observable review phases.
- 2f7c7a8: Show the active branch in the TUI header. The engine now emits a `branch:changed` event from its
  own git view of the checkout - at Run start (so a resumed run in an isolated worktree shows the
  feature branch immediately) and whenever a Step advances HEAD onto a different branch. The presenter
  folds it into `ViewState.currentBranch`, and the TUI header renders a middle-truncated `⎇ <branch>`
  segment. It tracks core's branch reading, not any pipeline's branch-name artifact, so it stays
  accurate for custom pipelines.
- a9f93ca: Enable mouse-wheel scrolling in the run TUI: the activity panel and step inspector now take the scroll wheel directly. This turns on terminal mouse reporting, which replaces the terminal's native click-drag text selection.
- b444dde: Add an `o` keybinding to the ship TUI that opens the Run's pull request in the browser (lazygit-style), once a PR exists.
- e18ad76: Keep the pipeline rail aligned and single-line. Step names and phase labels that overflow the narrow rail now truncate with an ellipsis instead of wrapping, so the glyph/spinner column, names, and elapsed timestamps stay in tidy columns. Also fix a duration-rounding bug where a value just under a minute rendered as `1m 60s` (or a bare `60s`) instead of rolling over to `2m 00s` / `1m 00s`.
- a9f93ca: Fix the run TUI Summary tab freezing when navigating between steps. It hoisted the step prop into a local const, capturing a stale value, so it only refreshed when switching tabs; it now reads the prop reactively and follows j/k step navigation.
- 7dc58ab: Share view rendering decisions across renderers and keep cancellation plus multiline plain output consistent.
- cad7ab9: Show a static amber glyph instead of the busy spinner on an active Step that is blocked awaiting a human decision (an `ask`/`approval` gate), so the pipeline rail reads as "waiting on you" rather than "working".
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
