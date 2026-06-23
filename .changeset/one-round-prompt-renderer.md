---
"@tml/core": patch
---

Move the round-history prompt renderer out of the round executor into `round.ts` as the exported `renderRoundsForPrompt` (with a `renderRoundForPrompt` per-round helper), alongside the existing PR-summary renderer. All `RoundRecord`-to-text rendering now lives in one module, and the executor calls the shared renderer for both fresh-agent history and approval-gate context.
