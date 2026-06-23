---
"@tml/core": patch
"@tml/defaults": patch
---

Render round history with a single shared prompt renderer (`renderRoundsForPrompt`) instead of two near-duplicate copies in the round executor and the approval gate. The executor's history now includes user notes too, fixing the drift where fresh-agent prompts and the approval-gate context disagreed on what a prior round contained.
