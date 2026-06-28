---
"@tml/core": minor
"@tml/view": minor
"tml": minor
---

Add `tml stats`: a lifetime view of the pipeline across journaled runs. It rolls up every checkout (`--here` narrows to the current one), folding all clones and worktrees of a repo into one row by their git remote, and reports it in tml's own visual language - the `▶`/`─` run header, the finding-lifecycle glyph tally (`✓` fixed/accepted, `✗` unresolved, `⤼` skipped, `○` open), the `▸` pipeline rail with per-step seen/fixed, and `[disposition]` severity markers. `--json` emits the raw figures.

Core gains `readRunHistory` and `summarizeRunStats`; view gains `renderStats`.
