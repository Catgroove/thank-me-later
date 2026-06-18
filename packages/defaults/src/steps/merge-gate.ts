// `merge-gate` — the terminal step. It reads a fresh PR snapshot and computes readiness from four
// conditions: every check succeeded, the PR isn't blocked by review state, every review thread is
// resolved, and GitHub reports it mergeable (an `unknown` mergeable counts as not-ready —
// conservative, the gate stays closed). It reports the verdict + the list of blockers and produces
// `mergeReadiness`. It **does not merge and never will** — that is an explicit non-goal. When not
// ready the run simply finishes parked (not failed); a re-entry re-evaluates.

import { defineStep, type Step } from "@tml/core";
import { mergeReadiness, pullRequest } from "../artifacts.ts";

export function mergeGateStep(): Step {
  return defineStep({
    name: "merge-gate",
    consumes: [pullRequest],
    produces: [mergeReadiness],
    async run(ctx) {
      // Read a fresh snapshot: review/respond-comments and CI all moved state since open-pr.
      const pr = await ctx.forge.getPullRequest(ctx.read(pullRequest).number);
      const blockers: string[] = [];

      const failing = pr.checks.filter((c) => c.conclusion !== "success");
      if (failing.length > 0) {
        blockers.push(`checks not green: ${failing.map((c) => c.name).join(", ")}`);
      }
      if (pr.reviewDecision === "changes_requested") blockers.push("changes requested");
      if (pr.reviewDecision === "review_required") blockers.push("review required");
      const unresolved = pr.threads.filter((t) => !t.resolved).length;
      if (unresolved > 0)
        blockers.push(`${unresolved} unresolved thread${unresolved === 1 ? "" : "s"}`);
      if (pr.mergeable !== "mergeable") blockers.push(`mergeable: ${pr.mergeable}`);

      const ready = blockers.length === 0;
      if (ready) {
        ctx.log("merge-gate: ready to merge (tml does not merge — it's yours to merge)");
      } else {
        ctx.log(`merge-gate: not ready — ${blockers.join("; ")}`);
      }
      return { mergeReadiness: { ready, blockers } };
    },
  });
}
