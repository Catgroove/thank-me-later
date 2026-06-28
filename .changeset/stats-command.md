---
"@tml/core": minor
"@tml/view": minor
"tml": minor
---

Add `tml stats`: a summary of findings caught and fixed across journaled runs. Scans every checkout by default (`--here` narrows to the current one), folds all clones and worktrees of a repo into one row by their git remote, and prints a banner, headline figures, fixes credited per step, and a top-repos table with horizontal gauges. `--json` emits the raw figures.

Core gains `readRunHistory` and `summarizeRunStats`; view gains `renderStats`.
