---
"@tml/view": patch
---

Keep the pipeline rail aligned and single-line. Step names and phase labels that overflow the narrow rail now truncate with an ellipsis instead of wrapping, so the glyph/spinner column, names, and elapsed timestamps stay in tidy columns. Also fix a duration-rounding bug where a value just under a minute rendered as `1m 60s` (or a bare `60s`) instead of rolling over to `2m 00s` / `1m 00s`.
