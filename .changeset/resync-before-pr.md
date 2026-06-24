---
"@tml/defaults": minor
---

Re-sync onto the latest base right before opening the PR. The default pipeline now runs the rebase
step a second time as `resync`, between `review` and `open-pr`, so the PR opens (and CI runs) on the
freshly fetched base even when it drifted during the slow checks/review phase. It reuses the existing
rebase step's agent-driven conflict resolution and is a cheap no-op when the base has not moved.
Disable it with `disable: ["resync"]` in `tml.json`; the earlier `rebase` is unchanged.
