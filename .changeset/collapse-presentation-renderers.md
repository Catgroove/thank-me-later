---
"@tml/view": patch
---

Collapse the CLI and plain terminal renderers into one output module (`createTerminalRenderer`) that selects live (TTY) or append-only mechanics internally, so artifact, prompt, and results rules live in one place instead of being copied per renderer.
