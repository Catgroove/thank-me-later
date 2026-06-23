---
"@tml/core": patch
---

Scope `auto` Run Journal resume to the git branch you're on. Previously `tml ship` resumed the latest unfinished journal run for the checkout whenever the pipeline matched, so a fresh ship from the default branch replayed a prior shipment's completed Steps - skipping branch creation, commit, and the local checks, and re-pushing a stale feature branch (which then failed `--force-with-lease`). Runs now record a `resumeKey` (the branch they're shipping, advanced to the feature branch once one is cut), and `auto` resume only continues a parked run whose branch matches the one you're on. A fresh ship from the default branch now starts clean; re-running on the feature branch still resumes. Legacy keyless journals remain resumable from a keyless start.
