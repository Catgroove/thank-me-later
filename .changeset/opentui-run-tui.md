---
"@tml/core": minor
"@tml/view": minor
"tml": minor
---

Add a full-screen OpenTUI/Solid TUI as the default interactive presentation for `tml ship`. A TTY now opens an alternate-screen dashboard - an ordered Pipeline rail, a generic per-Step inspector (Summary, Artifacts, Findings, Rounds), and an always-visible activity panel that follows the full cross-Step trail - and resolves `ctx.ask`/`ctx.approveFindings` through inline drawers. `--plain`/`--no-tui` and non-TTY output keep the existing append-only renderer. Every `RunEvent` now carries an `at` timestamp and the engine emits `round:recorded`, so completed durations and Finding/Round data come from structured events rather than renderer-local guesses. The TUI is Pipeline-generic: it makes no assumptions about the default Step names.
