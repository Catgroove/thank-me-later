---
"@tml/core": patch
"@tml/defaults": patch
---

Merge the approval gate into the Round loop. `executeRoundLoop` now handles its own approval escalation: when a check stops needing a user and the Step supplies a `stepName`, the loop routes the findings through `ctx.approveFindings` inline, continuing with an operator fix or ending on approve/skip/abort. This deletes the separate `approval-gate` module and the loop's re-entry options (`initialRounds`, `initialAttempts`, `initialFixFindings`); Steps call `executeRoundLoop` directly.
