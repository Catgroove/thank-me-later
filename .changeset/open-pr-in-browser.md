---
"tml": patch
---

Refine `openInBrowser` handling so `tml ship` keeps the checkout's setting during isolated-run config rebuilds and opens the PR only after renderer teardown and the TUI epilogue.
