// `open-pr` — commit the work, push the branch, and open the PR. Idempotent (ADR-0004): if
// a PR already exists for this head branch, reuse it and skip the open, so a re-run never
// double-opens. The PR title + body are agent-written (structured output); when tml creates a
// commit, the title doubles as its subject. The base is the repo's default branch.

import { defineStep, type Step } from "@tml/core";
import { branchName, pullRequest, reviewSummary } from "../artifacts.ts";
import { prDescriptionPrompt, prDescriptionSchema } from "../prompts.ts";

interface Description {
  readonly title: string;
  readonly body: string;
}

/** Validate the agent's structured output is a usable `{ title, body }`. */
function asDescription(output: unknown): Description {
  if (typeof output === "object" && output !== null) {
    const { title, body } = output as Record<string, unknown>;
    if (typeof title === "string" && typeof body === "string") return { title, body };
  }
  throw new Error("open-pr: the agent did not return a { title, body } description");
}

export function openPrStep(): Step {
  return defineStep({
    name: "open-pr",
    consumes: [branchName, reviewSummary],
    produces: [pullRequest],
    async run(ctx) {
      const head = ctx.read(branchName);

      const existing = await ctx.forge.findPullRequest(head);
      if (existing) return { pullRequest: existing };

      const reply = await ctx.agent.run(prDescriptionPrompt(ctx.read(reviewSummary)), {
        schema: prDescriptionSchema,
      });
      const { title, body } = asDescription(reply.output);

      await ctx.git.stageAll();
      const status = await ctx.git.status();
      if (status.staged.length > 0) {
        await ctx.git.commit(title); // the PR title is the commit subject when tml creates one
      } else {
        ctx.log("no uncommitted changes to commit; pushing existing commits");
      }
      await ctx.git.push({ branch: head }); // push the feature branch we ship under (ADR-0012)

      const base = await ctx.git.defaultBranch();
      const pr = await ctx.forge.openPullRequest({ head, base, title, body });
      return { pullRequest: pr };
    },
  });
}
