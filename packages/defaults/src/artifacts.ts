// The typed artifacts that flow between the default pipeline's Steps (ADR-0003/0006).
// `branch` produces the branch name; `describe` produces the PR title + body (the title also
// becomes the work's commit subject); `review` produces the review summary `open-pr` folds into
// the body; `open-pr` produces the PullRequest that `ci-wait` polls.

import { defineArtifact, type PullRequest } from "@tml/core";

export const branchName = defineArtifact<string>()("branchName");
/** The PR title (and the work's commit subject) — written once by `describe`, reused downstream. */
export const prTitle = defineArtifact<string>()("prTitle");
/** The PR body — written by `describe`; `open-pr` folds the review summary in. */
export const prBody = defineArtifact<string>()("prBody");
export const reviewSummary = defineArtifact<string>()("reviewSummary");
export const pullRequest = defineArtifact<PullRequest>()("pullRequest");
