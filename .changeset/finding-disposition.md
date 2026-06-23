---
"@tml/core": patch
"@tml/defaults": patch
"@tml/view": patch
---

Classify findings by disposition instead of compiler-style severity. A finding now carries
`disposition: "blocker" | "should-fix" | "consider" | "nit"` in place of the old
`severity: "error" | "warning" | "info"`, and the separate `blocking` flag is gone - `blocker`
subsumes it. Disposition states how strongly tml recommends acting, which is what a human
triaging the approval gate actually needs, and the action constraint follows it: `blocker` and
`should-fix` findings must be auto-fix or ask-user, while `consider` and `nit` may use any
action. Review and check prompts, the PR risk summary, and the TUI labels/colors all speak the
new vocabulary.
