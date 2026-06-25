// `rebase` keeps the work building on the latest base. The default Pipeline runs it right after
// `commit-change` so checks, review, and CI all see a freshly fetched base. `open-pr` performs one
// final internal sync with the same helper right before pushing, so the PR opens on the latest base
// even if it drifted during the slow checks/review phase. It only acts when the work is committed.
//
// It rebases onto `origin/<default>` only. It deliberately never fetches the feature branch. That
// keeps `open-pr`'s `--force-with-lease` honest: if the remote head diverged on another machine or
// by a teammate, the lease fails loudly instead of clobbering, rather than us silently adopting and
// overwriting those commits.
//
// Skips cheaply when there is nothing to do (no remote, or the base is already an ancestor of HEAD).
// On conflicts it asks the agent to resolve them in place; if the agent cannot finish, it aborts the
// rebase to leave the branch pristine and fails with guidance, handing the rebase back to the human.
// If the rebase drops every commit (the work already landed upstream), there is nothing to ship.

import { cancel, defineStep, skip, type Ctx, type FlowSignal, type Step } from "@tml/core";
import { rebaseConflictPrompt } from "../prompts.ts";

type BaseSyncOutcome = "skipped" | "synced" | FlowSignal;

export function rebaseStep(): Step {
  return defineStep({
    name: "rebase",
    display: { label: "Rebase" },
    async run(ctx) {
      const result = await syncBase(ctx);
      if (result === "skipped") return skip();
      if (result === "synced") return {};
      return result;
    },
  });
}

export async function syncBase(ctx: Ctx): Promise<BaseSyncOutcome> {
  const base = await ctx.git.defaultBranch();
  const baseRef = `origin/${base}`;

  // Refresh the base. No remote (or an unreachable one) means there is nothing to rebase onto.
  try {
    await ctx.git.fetch(base);
  } catch {
    ctx.log(`no ${baseRef} to rebase onto; skipping`);
    return "skipped";
  }

  // Already building on top of the latest base: nothing to replay. If the refs are equal,
  // there are no branch commits left to ship, so stop before opening an empty PR.
  if (await ctx.git.isAncestor(baseRef, "HEAD")) {
    if (await ctx.git.isAncestor("HEAD", baseRef)) {
      return cancel(`nothing to ship: this work is already in ${base}`);
    }
    ctx.log(`already up to date with ${baseRef}`);
    return "skipped";
  }

  ctx.log(`rebasing onto ${baseRef}`);
  const result = await ctx.git.rebase(baseRef);

  if (result.status === "conflict") {
    ctx.log(`conflicts in ${result.files.join(", ")}; asking the agent to resolve`);
    const reply = await ctx.agent.run(rebaseConflictPrompt(baseRef, result.files));
    const stillRebasing = await ctx.git.rebaseInProgress();
    if (!reply.ok || stillRebasing) {
      if (stillRebasing) await ctx.git.rebaseAbort();
      const guidance = stillRebasing
        ? "Your branch is untouched - rebase it manually, then re-run tml ship."
        : "The rebase is no longer in progress; inspect the branch, then re-run tml ship.";
      throw new Error(
        `rebase onto ${baseRef} hit conflicts the agent could not resolve ` +
          `(${result.files.join(", ")}). ${guidance}`,
      );
    }
    ctx.log("agent resolved the rebase conflicts");
  }

  // If the rebase dropped every commit, this work is already in the base. Nothing to ship.
  if (await ctx.git.isAncestor("HEAD", baseRef)) {
    return cancel(`nothing to ship: this work is already in ${base}`);
  }

  return "synced";
}
