---
"@tml/defaults": patch
"@tml/view": patch
"@tml/pi": patch
---

Make review output readable instead of raw structured data. The agent's findings JSON no longer streams into the log: a schema run's text payload is suppressed at the harness (tool activity still streams), and the review pass logs a plain-English line of what it found and, on completion, a found-to-outcome overview (`N findings → M auto-fixed · K need your decision · J noted`). The pipeline rail now shows a compact per-step finding tally (✓ fixed, ✗ unresolved, ? needs you, ⟳ pending) so fix status reads at a glance, the Findings tab sorts by severity (worst first), and the PR-body review summary shows every finding with its lifecycle status so a reader can tell what was fixed and what still stands.
