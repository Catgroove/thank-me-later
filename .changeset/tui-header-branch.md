---
"@tml/core": patch
"@tml/view": patch
---

Show the active branch in the TUI header. The engine now emits a `branch:changed` event from its
own git view of the checkout - at Run start (so a resumed run in an isolated worktree shows the
feature branch immediately) and whenever a Step advances HEAD onto a different branch. The presenter
folds it into `ViewState.currentBranch`, and the TUI header renders a middle-truncated `⎇ <branch>`
segment. It tracks core's branch reading, not any pipeline's branch-name artifact, so it stays
accurate for custom pipelines.
