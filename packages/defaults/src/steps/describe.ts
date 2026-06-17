// `describe` — one agent call that writes the change's description up front: a Conventional-Commits
// title and a Markdown body, from the diff. The title doubles as the work's commit subject (so the
// initial commit isn't detached from what changed) and the PR title; the body is the PR body.
//
// On a re-entry where the PR already exists, `describe` does *not* rewrite the description — a human
// may have edited it, and `review` owns its own delimited block within the body. It reuses the open
// PR's title + body so downstream steps still have them. Otherwise it describes the change once,
// keeping the initial commit and the PR consistent.

import { defineStep, type Step } from "@tml/core";
import { branchName, prBody, prTitle } from "../artifacts.ts";
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
    consumes: [branchName],
    produces: [prTitle, prBody],
    async run(ctx) {
      // A re-entry against an already-open PR keeps the existing description (it may carry human
      // edits + review's delimited block); only the first ship describes the change.
      const existing = await ctx.forge.findPullRequest(ctx.read(branchName));
      if (existing && existing.state === "open") {
        ctx.log("reusing the open PR's description");
        return { prTitle: existing.title, prBody: existing.body };
      }

      const reply = await ctx.agent.run(prDescriptionPrompt(), { schema: prDescriptionSchema });
      const { title, body } = asDescription(reply.output);
      return { prTitle: title, prBody: body };
    },
  });
}
