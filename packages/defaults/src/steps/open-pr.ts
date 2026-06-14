// `open-pr` — push the branch and open the PR. The work and the fixes were already committed by the
// commit Steps before this point, so `open-pr` no longer commits; it pushes what's there and opens
// the PR. Idempotent (ADR-0004): if a PR already exists for this head branch, reuse it and skip the
// open, so a re-run never double-opens. The title + body come from `describe`; the review summary is
// folded into the body here. The base is the repo's default branch.

import { defineStep, type Step } from "@tml/core";
import { branchName, prBody, prTitle, pullRequest, reviewSummary } from "../artifacts.ts";

/** Append the review summary to the description body as its own section, when there is one. */
function withReview(body: string, review: string): string {
  return review.trim().length > 0 ? `${body}\n\n## Review\n\n${review}` : body;
}

export function openPrStep(): Step {
  return defineStep({
    name: "open-pr",
    consumes: [branchName, prTitle, prBody, reviewSummary],
    produces: [pullRequest],
    async run(ctx) {
      const head = ctx.read(branchName);

      const existing = await ctx.forge.findPullRequest(head);
      if (existing) return { pullRequest: existing };

      await ctx.git.push({ branch: head }); // push the feature branch we ship under (ADR-0012)

      const base = await ctx.git.defaultBranch();
      const title = ctx.read(prTitle);
      const body = withReview(ctx.read(prBody), ctx.read(reviewSummary));
      const pr = await ctx.forge.openPullRequest({ head, base, title, body });
      return { pullRequest: pr };
    },
  });
}
