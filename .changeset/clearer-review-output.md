---
"@tml/defaults": patch
"@tml/view": patch
"@tml/pi": patch
---

Make review output readable instead of raw structured data. The agent's findings JSON no longer streams into the log: a schema run's text payload is suppressed at the harness (tool activity still streams), and the review pass logs a plain-English line of what it found and, on completion, a found-to-outcome overview (`N findings → M auto-fixed · K need your decision · J noted`). In the TUI, each finding leads with its title (severity badge and status glyph alongside, file:line and detail below) in both the findings tab and the approval drawer, the findings tab sorts by severity (worst first) and shows lifecycle status so you can tell what was fixed, and the PR-body review summary shows every finding with its lifecycle status so a reader can tell what was fixed and what still stands.
