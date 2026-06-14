// `review` — a pre-push agent review of the branch's diff against the default branch. The
// agent computes the diff itself (it has shell access), applies safe fixes, and summarises
// what it found. The summary becomes the `reviewSummary` artifact `open-pr` folds into the
// PR body.

import { defineStep, type Step } from "@tml/core";
import { reviewSummary } from "../artifacts.ts";
import { reviewPrompt } from "../prompts.ts";

export function reviewStep(): Step {
  return defineStep({
    name: "review",
    produces: [reviewSummary],
    async run(ctx) {
      const result = await ctx.agent.run(reviewPrompt);
      return { reviewSummary: result.summary };
    },
  });
}
