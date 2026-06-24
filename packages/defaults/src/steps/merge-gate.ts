// `merge-gate` - the final gate after CI: confirm the host will actually let the PR merge. CI being
// green is necessary but not sufficient - the PR can still be behind its base, conflicted, blocked
// by branch protection (a required review or status check), or left as a draft. This Step polls the
// host's merge-readiness verdict until it settles and, when the PR is not mergeable, surfaces a
// finding through the same issue -> fix -> verify loop the other Steps use. It deliberately does not
// re-derive the CI verdict from the merge state (which only reflects CI for *required* checks);
// `ci-wait` owns that gate. Disable it with `disable: ["merge-gate"]` in tml.json.

import {
  TimeoutError,
  defineStep,
  executeRoundLoop,
  isMergeable,
  makeFinding,
  skip,
  type Ctx,
  type Finding,
  type MergeState,
  type Step,
} from "@tml/core";
import { pullRequest } from "../artifacts.ts";
import { mergeGatePrompt } from "../prompts.ts";

/** Poll cadence: every 10s, give up after 30min - mirrors `ci-wait`, since both wait on the host. */
const EVERY_MS = 10_000;
const TIMEOUT_MS = 30 * 60_000;
const MAX_MERGE_FIX_ATTEMPTS = 2;

/** Per-state guidance for the operator; only the non-mergeable states need a finding. */
function mergeBlocker(
  state: MergeState,
  base: string,
): { disposition: Finding["disposition"]; detail: string } | null {
  switch (state) {
    case "behind":
      return {
        disposition: "blocker",
        detail: `The branch is behind ${base}; rebase it onto the latest base so it can merge.`,
      };
    case "dirty":
      return {
        disposition: "blocker",
        detail: `The PR has merge conflicts with ${base}; rebase and resolve them.`,
      };
    case "blocked":
      return {
        disposition: "blocker",
        detail:
          "Merging is blocked by branch protection - a required review or status check is unmet.",
      };
    case "draft":
      return {
        disposition: "should-fix",
        detail: "The PR is a draft; mark it ready for review before it can merge.",
      };
    default:
      return null; // clean | has_hooks | unstable | unknown - mergeable or not yet settled
  }
}

function mergeFinding(state: MergeState, base: string): Finding | null {
  const blocker = mergeBlocker(state, base);
  if (blocker === null) return null;
  return makeFinding("merge", {
    disposition: blocker.disposition,
    // A human decides: the fixes here (rebase, force-push, marking ready) change the PR itself,
    // not just files, so they should not run unattended.
    action: "ask-user",
    title: `PR is not mergeable (${state})`,
    detail: blocker.detail,
  });
}

function timeoutFinding(prNumber: number): Finding {
  return makeFinding("merge", {
    disposition: "should-fix",
    action: "ask-user",
    title: "Merge readiness did not settle before the timeout",
    detail: `The host had not computed a merge state for PR #${prNumber} when the wait timeout elapsed.`,
  });
}

export function mergeGateStep(): Step {
  return defineStep({
    name: "merge-gate",
    consumes: [pullRequest],
    resume: "reconcile",
    async run(ctx: Ctx) {
      const pr = ctx.read(pullRequest);
      // Bind so the poller keeps its provider `this` when called detached below.
      const getMergeability = ctx.gitProvider.getMergeability?.bind(ctx.gitProvider);
      if (getMergeability === undefined) {
        ctx.log("merge-gate: provider does not report merge readiness; skipping");
        return skip();
      }

      let latestState: MergeState = "unknown";
      const result = await executeRoundLoop(ctx, {
        stepName: "merge-gate",
        maxAutoFixAttempts: MAX_MERGE_FIX_ATTEMPTS,
        async check() {
          try {
            latestState = await ctx.until(getMergeability(pr.number), {
              every: EVERY_MS,
              timeout: TIMEOUT_MS,
            });
          } catch (error) {
            if (error instanceof TimeoutError) return { findings: [timeoutFinding(pr.number)] };
            throw error;
          }
          ctx.log(`merge: ${latestState}${isMergeable(latestState) ? " (mergeable)" : ""}`);
          const finding = mergeFinding(latestState, pr.base);
          return { findings: finding ? [finding] : [] };
        },
        async fix(input) {
          const agentResult = await ctx.agent.run(
            mergeGatePrompt({
              state: latestState,
              base: pr.base,
              findings: input.findings,
              historyText: input.historyText,
            }),
          );
          return { summary: agentResult.summary };
        },
        // The fix mutates the branch and PR directly (rebase, force-push, mark ready); the agent
        // owns its own git, so the loop takes no commit and just re-polls the merge state to verify.
        commit: false,
      });

      return { artifacts: {}, rounds: result.rounds };
    },
  });
}
