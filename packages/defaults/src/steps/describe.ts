// `describe` — one agent call that writes the change's description up front: a Conventional-Commits
// title and a Markdown body, from the diff. The title doubles as the work's commit subject (so the
// initial commit isn't detached from what changed) and the PR title; the body is the PR body, into
// which `open-pr` later folds the review summary. Running it once keeps the commit and the PR
// consistent instead of describing the same change twice.

import { defineStep, type Step } from "@tml/core";
import { prBody, prTitle } from "../artifacts.ts";
import { prDescriptionPrompt, prDescriptionSchema } from "../prompts.ts";

/** Pull a usable `{ title, body }` out of the agent's structured reply. */
function asDescription(output: unknown): { title: string; body: string } {
  if (typeof output === "object" && output !== null) {
    const { title, body } = output as Record<string, unknown>;
    if (typeof title === "string" && typeof body === "string" && title.trim().length > 0) {
      return { title: title.trim(), body: body.trim() };
    }
  }
  throw new Error("describe: the agent did not return a { title, body } description");
}

export function describeStep(): Step {
  return defineStep({
    name: "describe",
    produces: [prTitle, prBody],
    async run(ctx) {
      const reply = await ctx.agent.run(prDescriptionPrompt(), { schema: prDescriptionSchema });
      const { title, body } = asDescription(reply.output);
      return { prTitle: title, prBody: body };
    },
  });
}
