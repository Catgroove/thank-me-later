---
"@tml/defaults": minor
---

Re-sync onto the latest base as part of `open-pr` before pushing the branch. The default pipeline now
keeps the final publish-time base sync but no longer exposes it as a separate `resync` step, reducing
pipeline noise while ensuring the PR opens and CI starts from a freshly fetched base when the base
moves during checks or review.
