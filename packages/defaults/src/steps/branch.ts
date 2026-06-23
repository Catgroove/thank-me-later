// `branch` - the first Step: make sure the work lands on a feature branch before anything is
// committed or pushed. tml ship runs inside the isolated workspace created from the source checkout.
//
// If you are already on a feature branch, tml ships under it — unless that branch is *spent*: its
// PR has already merged or closed, so it's the wrong place for new work (you stayed on it instead
// of switching back to the default branch). We ask the Git provider for the branch's PR state rather than
// inferring it from git, because a squash-merge never makes the feature commits ancestors of the
// default branch. A spent branch is treated like the default-branch case below, but the new branch
// is cut off the freshly fetched default branch so the work starts from the merged state.
//
// Otherwise (you're on the default branch, a detached HEAD, or a spent branch) the Branch mode
// decides how to get one:
//   • ai      — the agent reads the diff and names the branch (the default)
//   • auto    — synthesize a deterministic `tml/ship-<sha>` name, no agent call
//   • require — refuse: you must already be on a feature branch
// `git checkout -b` carries the uncommitted changes onto the new branch, so the work follows you.

import { defineStep, type Step } from "@tml/core";
import { branchName } from "../artifacts.ts";
import { branchNamePrompt, branchNameSchema } from "../prompts.ts";

/** How the `branch` Step gets a feature branch when you aren't already on one. */
export const BRANCH_MODES = ["ai", "auto", "require"] as const;
export type BranchMode = (typeof BRANCH_MODES)[number];

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

      // Already on a feature branch → ship under it, unless its PR has merged/closed (spent).
      let spent = false;
      if (onFeatureBranch) {
        const pr = await ctx.gitProvider.findPullRequest(current);
        if (!pr || pr.state === "open") {
          ctx.log(`shipping on ${current}`);
          return { branchName: current };
        }
        spent = true;
        ctx.log(`${current}'s PR is ${pr.state}; cutting a fresh branch off ${base}`);
      }

      // Create a branch, off the freshly fetched default branch when the current one is spent,
      // else off the current HEAD (which, on the default branch, is already the base).
      let fetchedBase = false;
      const fetchBase = async (): Promise<void> => {
        if (!spent || fetchedBase) return;
        await ctx.git.fetch(base);
        fetchedBase = true;
      };
      const create = async (name: string): Promise<void> => {
        if (spent) {
          if (name === current) {
            throw new Error(
              `tml ship: ${current}'s PR is spent, but the new branch name resolved to the ` +
                "same branch. Choose a fresh branch name.",
            );
          }
          await fetchBase();
          await ctx.git.createBranch(name, { from: `origin/${base}` });
        } else {
          await ctx.git.createBranch(name);
        }
        ctx.log(`created ${name}`);
      };

      switch (mode) {
        case "require":
          throw new Error(
            spent
              ? `tml ship: ${current}'s PR is already merged/closed, so it's spent. Create a ` +
                  `fresh branch off ${base} first, e.g. \`git switch -c feat/your-change ${base}\`.`
              : "tml ship: you're not on a feature branch (you're on " +
                  `"${current === "HEAD" ? "a detached HEAD" : base}"). Create one first, e.g. ` +
                  "`git switch -c feat/your-change`.",
          );
        case "auto": {
          await fetchBase();
          const name = branchNameFor(await ctx.git.headSha(spent ? `origin/${base}` : undefined));
          await create(name);
          return { branchName: name };
        }
        case "ai": {
          const reply = await ctx.agent.run(branchNamePrompt, { schema: branchNameSchema });
          const name = asBranchName(reply.output);
          await create(name);
          return { branchName: name };
        }
      }

      throw new Error(`branch: unsupported branch mode "${String(mode)}"`);
    },
  });
}
