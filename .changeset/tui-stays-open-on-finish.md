---
"@tml/view": minor
"tml": patch
---

Keep the full-screen TUI up when the pipeline finishes instead of tearing it down the instant the run
ends. After a finished (or failed) run the dashboard stays interactive - the pipeline rail, inspector,
and activity panel remain navigable - with a banner showing the outcome and the PR link, and leaves
only when the user presses `q`/`enter`/`esc`. `@tml/view` adds an optional `awaitDismissal()` to the
interactive renderer; `ship()` awaits it before teardown. Plain/non-TTY renderers omit it, so CI and
piped runs still return the moment the run ends. A user-driven cancel still exits at once.
