// `branch` — the first Step: make sure the work lands on a feature branch before anything is
// committed or pushed. tml ship runs in place (ADR-0010), so this operates on the live checkout.
//
// If you are already on a feature branch, tml ships under it. Otherwise (you're on the default
// branch or a detached HEAD) the Branch mode decides how to get one (ADR-0012):
//   • ai      — the agent reads the diff and names the branch (the default)
//   • auto    — synthesize a deterministic `tml/ship-<sha>` name, no agent call
//   • require — refuse: you must already be on a feature branch
// `git checkout -b` carries the uncommitted changes onto the new branch, so the work follows you.

import { defineStep, type Step } from "@tml/core";
import { branchName } from "../artifacts.ts";
import { branchNamePrompt, branchNameSchema } from "../prompts.ts";

/** How the `branch` Step gets a feature branch when you aren't already on one. */
export type BranchMode = "ai" | "auto" | "require";

/** Derive a deterministic feature-branch name from an abbreviated commit SHA (the `auto` mode). */
export function branchNameFor(sha: string): string {
  return `tml/ship-${sha}`;
}

/** Pull the `{ branch }` string out of the agent's structured reply. */
function asBranchName(output: unknown): string {
  if (typeof output === "object" && output !== null) {
    const { branch } = output as Record<string, unknown>;
    if (typeof branch === "string" && branch.trim().length > 0) return branch.trim();
  }
  throw new Error("branch: the agent did not return a { branch } name");
}

export function branchStep(mode: BranchMode = "ai"): Step {
  return defineStep({
    name: "branch",
    produces: [branchName],
    async run(ctx) {
      const current = await ctx.git.currentBranch();
      const base = await ctx.git.defaultBranch();
      const onFeatureBranch = current !== "HEAD" && current !== base;

      // Already on a feature branch → ship under it, whatever the mode.
      if (onFeatureBranch) {
        ctx.log(`shipping on ${current}`);
        return { branchName: current };
      }

      switch (mode) {
        case "require":
          throw new Error(
            "tml ship: you're not on a feature branch (you're on " +
              `"${current === "HEAD" ? "a detached HEAD" : base}"). Create one first, e.g. ` +
              "`git switch -c feat/your-change`.",
          );
        case "auto": {
          const name = branchNameFor(await ctx.git.headSha());
          await ctx.git.createBranch(name);
          ctx.log(`created ${name}`);
          return { branchName: name };
        }
        case "ai": {
          const reply = await ctx.agent.run(branchNamePrompt, { schema: branchNameSchema });
          const name = asBranchName(reply.output);
          await ctx.git.createBranch(name);
          ctx.log(`created ${name}`);
          return { branchName: name };
        }
      }

      throw new Error(`branch: unsupported branch mode "${String(mode)}"`);
    },
  });
}
