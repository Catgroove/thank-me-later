---
"@tml/defaults": minor
---

Make `review` an extensive, staff-engineer-style review. The single-shot review step is
replaced by five focused read-only passes — context & intent, architecture & scope (a "drop
everything and reject" gate), correctness & testing, design & non-functional, and
maintainability & micro (a guardrailed over-engineering sweep) — followed by one fix pass that
applies only the safe `auto-fix` findings. The PR's review summary is now richer markdown: a
deterministic overall risk level, severity-labelled findings (`Critical:`/`Warning:`/`Nit:`)
grouped by phase, and the fixes applied. A blocking architecture verdict is surfaced as a
high-risk banner for the human at merge time (it does not halt the run). `ask-user` findings are
listed for the human and never auto-applied.
