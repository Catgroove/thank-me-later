---
"@tml/core": minor
"@tml/defaults": minor
"tml": minor
---

Make the review step converge instead of churning:

- Review asks a finishable question - bugs, risks, and safe non-functional simplifications in the changed code, nothing about styling/lint/types - and returns no findings when the change is clean. The open-ended "thermo-nuclear" restructuring mandate is gone.
- Findings are triaged by action: only safe, mechanical issues are `auto-fix`; anything touching the author's intent (architecture, product behaviour) is `ask-user` and goes to the human approval gate, never looped on. Default is `ask-user` when in doubt.
- Review has its own fix budget of one attempt (decoupled from the global `maxFixAttempts`, which now governs only the objective quality/test/ci checks): it fixes the obvious things once, then stops.

Token cost is also cut: review no longer inlines the branch diff into every pass (it hands the agent the base ref and lets it read the worktree), round history fed to fresh agents is a compact, detail-free ledger, and the review preamble is a tight instruction block.

BREAKING: the `--auto` ship flag and the auto-approval policy are removed. With review converging on its own, the human approval gate is the stopping point; auto-resolving it would auto-fix the `ask-user` findings that must reach a human. The `@tml/core` exports `autoApproveResponder`, `autoApproveFindings`, and `ApprovalDecisionSource`, and the `RoundRecord.approvalSource` field, are removed.
