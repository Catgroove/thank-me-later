---
"@tml/core": minor
"@tml/github": minor
"@tml/defaults": minor
---

Reorder the pipeline so the PR opens before review, and give review its own PR-body block.

`open-pr` now runs before `review` and opens with `describe`'s title + body only — no review
summary folded in. `review` runs against the live PR and writes its headline + dashboard into a
delimited `<!-- tml:review -->…<!-- /tml:review -->` region of the PR body, replacing only that
region so human prose is preserved across re-runs. `describe` reuses an open PR's description
instead of rewriting it. A single `push` step lands the post-PR fix commits before `ci-wait`.

Adds `PullRequest.headSha`/`reviewDecision` and a set of write methods to the `Forge`
interface (`updatePullRequestBody`, `createReviewThread`, `replyToThread`, `resolveThread`,
`submitReview`, `lastReviewedSha`), implemented in `@tml/github` over `gh`/GraphQL.
