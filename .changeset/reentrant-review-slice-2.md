---
"@tml/defaults": minor
---

Post review's `ask-user` findings as resolvable PR threads, and skip re-reviewing unchanged code.

`review` now turns each line-anchored `ask-user` finding into a review thread stamped with an
invisible `tml:finding` marker, deduped by a stable `hash(path:line:title)` key so a settled
finding (open *or* resolved) is never re-posted; unanchored questions remain in the review
summary. A delta gate compares the PR head against the
SHA of tml's last submitted review and runs zero passes when nothing new was pushed, leaving the
existing body block untouched; otherwise it submits a COMMENT review tied to the head to advance
that resume marker. Review pass failures now fail the step instead of being folded in as empty
findings. The headline's "N threads need your decision" tally points at the open threads.
