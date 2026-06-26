---
"@tml/core": minor
"@tml/defaults": minor
"@tml/view": minor
---

Remove the Step display layer. Steps no longer carry renderer metadata: the `StepDisplay` type and the `display` field on `Step`/`defineStep` are gone from `@tml/core`, the default pipeline drops its `display` labels, and `@tml/view` renders each Step by its `name`. The CLI and TUI now show the raw Step name (e.g. `open-pr`, `ci-wait`, `merge-gate`) instead of a pretty label, and the "PR gate" rail grouping is removed.
