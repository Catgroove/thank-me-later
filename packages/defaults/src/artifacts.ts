// The typed artifacts that flow between the default pipeline's Steps (ADR-0003/0006).
// `branch` produces the branch name; `review` produces the review summary that `open-pr`
// folds into the PR body; `open-pr` produces the PullRequest that `ci-wait` polls.

import { defineArtifact, type PullRequest } from "@tml/core";

export const branchName = defineArtifact<string>()("branchName");
export const reviewSummary = defineArtifact<string>()("reviewSummary");
export const pullRequest = defineArtifact<PullRequest>()("pullRequest");
