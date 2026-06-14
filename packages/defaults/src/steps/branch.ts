// `branch` — the first Step: create the feature branch the rest of the pipeline ships from.
// The name is derived from the worktree's HEAD commit (deterministic, no agent call); the
// branch is created inside the worktree via the native Git capability (ADR-0007).

import { defineStep, type Step } from "@tml/core";
import { branchName } from "../artifacts.ts";

/** Derive the feature-branch name from an abbreviated commit SHA. */
export function branchNameFor(sha: string): string {
  return `tml/ship-${sha}`;
}

export function branchStep(): Step {
  return defineStep({
    name: "branch",
    produces: [branchName],
    async run(ctx) {
      const name = branchNameFor(await ctx.git.headSha());
      await ctx.git.createBranch(name);
      return { branchName: name };
    },
  });
}
