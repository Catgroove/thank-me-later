---
"@tml/defaults": patch
---

Reject malformed review verdicts and keep blocking summaries internally consistent. The
architecture pass now uses a schema that requires an explicit `verdict`, so the block gate can
no longer silently downgrade to a non-blocking summary when the agent omits it.
