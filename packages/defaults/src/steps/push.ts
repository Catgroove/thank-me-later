// `push` — a thin step that force-pushes the feature branch once, just before `ci-wait`. `open-pr`
// already pushed the initial work and opened the PR; the post-PR commit groups (`review`, later
// `respond-comments`) add fix commits locally, and this single push lands all of them on the open
// PR together. Force (with lease) for the same reason `open-pr` uses it: history may have been
// rewritten, but it refuses rather than clobbers if the remote head moved under us.

import { defineStep, type Step } from "@tml/core";
import { branchName } from "../artifacts.ts";

export function pushStep(): Step {
  return defineStep({
    name: "push",
    consumes: [branchName],
    async run(ctx) {
      await ctx.git.push({ branch: ctx.read(branchName), force: true });
      return {};
    },
  });
}
