// `open-pr` - sync, push, and open or refresh the PR. The work and fixes were already committed by
// earlier Steps, so this Step does not commit. It uses the PR body as the base audit surface: a
// generated, delimited summary block is created from artifacts and completed rounds and refreshed
// idempotently on re-runs. Default review findings stay out of PR comments and threads.

import { defineStep, type Step } from "@tml/core";
import { branchName, prBody, prTitle, pullRequest, reviewSummary } from "../artifacts.ts";
import { buildDefaultPrBody, updateDefaultPrBody } from "../pr-body.ts";
import { syncBase } from "./rebase.ts";

export function openPrStep(): Step {
  return defineStep({
    name: "open-pr",
    display: { label: "PR" },
    consumes: [branchName, prTitle, prBody, reviewSummary],
    produces: [pullRequest],
    resume: "reconcile",
    async run(ctx) {
      const head = ctx.read(branchName);

      const syncResult = await syncBase(ctx);
      if (syncResult !== "skipped" && syncResult !== "synced") return syncResult;

      // Push before the idempotency check so a re-run that created new local commits updates the
      // already-open PR instead of silently leaving those commits only in the checkout. Force with
      // lease because the sync may have rewritten history; it is a safe fast-forward otherwise and
      // refuses rather than clobbers if the remote head moved under us.
      await ctx.git.push({ branch: head, force: true }); // push the feature branch we ship under

      const bodyInput = {
        description: ctx.read(prBody),
        reviewSummary: ctx.read(reviewSummary),
        rounds: ctx.rounds(),
      };

      // Reuse only an open PR. A merged/closed PR for this head is spent, so open a fresh one.
      const existing = await ctx.gitProvider.findPullRequest(head);
      if (existing && existing.state === "open") {
        const body = updateDefaultPrBody(existing.body, bodyInput);
        if (body !== existing.body)
          await ctx.gitProvider.updatePullRequestBody({ prNumber: existing.number, body });
        return { pullRequest: { ...existing, body } };
      }

      const base = await ctx.git.defaultBranch();
      const title = ctx.read(prTitle);
      const body = buildDefaultPrBody(bodyInput);
      const pr = await ctx.gitProvider.openPullRequest({ head, base, title, body });
      return { pullRequest: pr };
    },
  });
}
