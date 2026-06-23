---
"@tml/core": minor
"@tml/view": patch
---

Derive a per-finding lifecycle so the Findings tab reads as a checklist that checks itself off. `@tml/core` adds `findingLifecycle`, `FindingStatus`, `FindingLifecycle`, and a `RoundResolution` marker recorded on the terminal round of an approval gate. The TUI Findings tab now shows the cumulative set across the whole round history - findings selected for fix show `pending`, a verified fix shows `fixed`, and an operator decision shows `accepted as-is`/`skipped` - instead of silently dropping resolved findings.
