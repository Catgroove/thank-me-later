---
"@tml/core": patch
"@tml/defaults": patch
"@tml/view": patch
---

Simplify internals across packages: collapse the single-pass `ReviewPass` machinery to a flat
`Finding[]` flow, remove the unused `fixedFindingIds` summary branch (the review summary now tallies
unresolved auto-fixes rather than ever marking them "(fixed)"), share one git-spawn helper, dedup the
findings-schema envelope and the "no prior rounds" sentinel, and consolidate the TUI finding-section
model, severity colors, and finding marker.

User-visible: the approval drawer's auto-fix section is now labelled "Auto-fix" (was "Auto-fix next
round"). `@tml/core` adds `hasPriorRounds` and drops `renderRoundForPr`/`renderRoundForPrompt` from
its public surface (use the `renderRounds*` forms); `@tml/view` no longer re-exports the secondary
fold view types (`StepView`, `ArtifactView`, `ToolView`, `PendingInteraction`, `ActivityEntry`).
