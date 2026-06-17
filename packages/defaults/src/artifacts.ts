// The typed artifacts that flow between the default pipeline's Steps.
// `branch` produces the branch name; `describe` produces the PR title + body (the title also
// becomes the work's commit subject); `open-pr` produces the PullRequest that `review` posts onto
// and `ci-wait` polls; `review` produces the review summary it writes into the PR's body block.

import { defineArtifact, type PullRequest } from "@tml/core";

/** Whether the PR is ready to merge, with the list of blockers when it is not. tml never merges. */
export interface MergeReadiness {
  readonly ready: boolean;
  readonly blockers: string[];
}

export const branchName = defineArtifact<string>()("branchName");
/** The PR title (and the work's commit subject) — written once by `describe`, reused downstream. */
export const prTitle = defineArtifact<string>()("prTitle");
/** The PR body — written by `describe`; `review` maintains its own delimited block within it. */
export const prBody = defineArtifact<string>()("prBody");
/** The review headline + dashboard `review` writes into the PR body's `tml:review` block. */
export const reviewSummary = defineArtifact<string>()("reviewSummary");
export const pullRequest = defineArtifact<PullRequest>()("pullRequest");
/** A one-line summary of what `respond-comments` did to the unresolved threads this run. */
export const respondSummary = defineArtifact<string>()("respondSummary");
/** The merge gate's readiness verdict + blockers. */
export const mergeReadiness = defineArtifact<MergeReadiness>()("mergeReadiness");
