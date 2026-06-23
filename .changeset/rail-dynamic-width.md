---
"@tml/view": patch
---

Size the TUI pipeline rail to its content: it now grows to fit the longest Step name (and an active Step's Phase labels) within a fixed width band, instead of a hardcoded 30 columns, so longer names and their elapsed times no longer collide.
