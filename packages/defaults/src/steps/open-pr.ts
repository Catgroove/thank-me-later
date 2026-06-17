// `open-pr` — push the branch and open the PR. The work and the fixes were already committed by the
// commit Steps before this point, so `open-pr` no longer commits; it pushes what's there and opens
// the PR. It now runs *before* `review`, so it opens with `describe`'s title + body only — review
// hasn't run yet and folds nothing in (it writes its own delimited body block once it has). The
// step is idempotent: if an open PR already exists for this head branch, reuse it and skip the open,
// so a re-run never double-opens (a merged/closed PR is spent — open a fresh one). The base is the
// repo's default branch.

import { defineStep, type Step } from "@tml/core";
import { branchName, prBody, prTitle, pullRequest } from "../artifacts.ts";

export function openPrStep(): Step {
  return defineStep({
    name: "open-pr",
    consumes: [branchName, prTitle, prBody],
    produces: [pullRequest],
    async run(ctx) {
      const head = ctx.read(branchName);

      // Push before the idempotency check so a re-run that created new local commits updates the
      // already-open PR instead of silently leaving those commits only in the checkout. Force (with
      // lease) because `rebase` may have rewritten history; it's a safe fast-forward otherwise and
      // refuses rather than clobbers if the remote head moved under us.
      await ctx.git.push({ branch: head, force: true }); // push the feature branch we ship under

      // Reuse only an open PR. A merged/closed PR for this head is spent — open a fresh one.
      const existing = await ctx.forge.findPullRequest(head);
      if (existing && existing.state === "open") return { pullRequest: existing };

      const base = await ctx.git.defaultBranch();
      const title = ctx.read(prTitle);
      const body = ctx.read(prBody);
      const pr = await ctx.forge.openPullRequest({ head, base, title, body });
      return { pullRequest: pr };
    },
  });
}
