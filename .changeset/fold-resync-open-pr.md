---
"@tml/defaults": patch
---

Fold the final publish-time base sync into `open-pr` so the default pipeline keeps opening PRs from a freshly fetched base without exposing a separate `resync` step.
