---
"@tml/core": patch
"@tml/view": patch
---

Stop the review/fix loop from re-running a fix that changes nothing. A verify round that
reproduces the previous check's exact findings is now treated as stalled and escalates to the
approval gate (or proceeds, when no gate is configured) instead of burning another identical
round. Operator-driven fixes remain uncapped by design - the human stays in control - but a
stalled gate now says so explicitly.

The step inspector's rounds tab also numbers the fix attempts (`fix 1`, `fix 2`, ...) next to
the raw round index, so "round 5" is legible as the third fix rather than an opaque counter.
