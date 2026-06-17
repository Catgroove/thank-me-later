---
"@tml/core": minor
"@tml/defaults": minor
---

Add a `rebase` step to the default pipeline. After the change is committed, tml rebases onto the
freshly fetched default branch so the checks, review, and CI all run against the current base. It
skips when there's nothing to do, asks the agent to resolve conflicts (aborting back to a pristine
branch and deferring to you if it can't), and cancels the run when the work has already landed
upstream. `open-pr` now force-pushes with `--force-with-lease` to carry the rewritten history
safely. Disable it with `disable: ["rebase"]` in `tml.json`.
