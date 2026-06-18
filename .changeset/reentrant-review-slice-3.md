---
"@tml/core": minor
"@tml/github": minor
"@tml/defaults": minor
---

Add the reentrant review-thread resolution loop and a merge-readiness gate.

A new `respond-comments` step reconciles the PR's unresolved review threads (the starting
snapshot): a 👍 on one of tml's own findings applies the change and resolves it, a 👎 dismisses
it, a reply is interpreted and acted on (a reply outweighs a reaction), and a thread tml didn't
open gets a reply but is left open. A ping-pong guard hands a thread to a human after three tml
turns. A new terminal `merge-gate` step reports readiness — green checks, no changes-requested
review, every thread resolved, and mergeable (`unknown` counts as not-ready) — and **never
merges**. Adds `ReviewThread.isOutdated`, `ReviewComment.isMine`, `PullRequest.reviewDecision`,
and the `replyToThread`/`resolveThread` Forge methods, implemented in `@tml/github`.
