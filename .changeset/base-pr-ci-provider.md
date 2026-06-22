---
"@tml/core": minor
"@tml/github": minor
---

Harden the base PR/CI GitProvider surface: keep PullRequest focused on PR metadata, mergeability, and checks; add PR body updates, optional mergeability polling, and optional failed-check-log retrieval; and keep review-thread/comment state out of the base provider contract.
