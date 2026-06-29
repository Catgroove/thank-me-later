---
"@tml/core": minor
"@tml/defaults": minor
"@tml/view": minor
"tml": minor
---

Add `--watch`: after the PR is ready, keep reconciling it (rebase, resolve conflicts, re-run CI) until it merges/closes or you quit.

`--watch` is a thin loop of Re-entries (no daemon, no background process): each tick is a resume of the same Run that replays the cheap local prefix from the journal and re-runs only the PR-reconciling tail (`open-pr` → `ci-wait` → `merge-gate`). It defaults on in an interactive terminal and off without a TTY (so an agent or CI run is never pinned waiting for a human merge); `--watch` / `--no-watch` force it either way, and a `watch` / `watchInterval` knob in `tml.json` sets the default and cadence.

Supporting changes: a new resumable `parked` run status and `park()` flow signal (a Run can now reach a clean, re-runnable rest instead of only `finished`); `merge-gate` detects a landed PR (merged/closed) and, under watch, parks once the PR is mergeable so the next tick reconciles it again.
