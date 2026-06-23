---
"@tml/view": patch
---

Fix the run TUI Summary tab freezing when navigating between steps. It hoisted the step prop into a local const, capturing a stale value, so it only refreshed when switching tabs; it now reads the prop reactively and follows j/k step navigation.
