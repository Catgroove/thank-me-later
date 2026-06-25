---
"@tml/defaults": patch
---

Combine the default format, lint, and typecheck gates into one quality step. The step keeps source-inspection checks for formatting and lint while running the real typecheck command, and removes the old separate prompt and step factories.
