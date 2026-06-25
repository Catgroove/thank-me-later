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
  makeFinding,
  type Ctx,
  type Finding,
  type MergeState,
  type Step,
} from "@tml/core";
import { pullRequest } from "../artifacts.ts";
import {
  isBypassEligibleMergeState,
  isMergeGateMergeable,
  mergeGateStatePolicy,
} from "../merge-gate-policy.ts";
import { mergeGatePrompt } from "../prompts.ts";

/** Poll cadence: every 10s, give up after 30min - mirrors `ci-wait`, since both wait on the host. */
const EVERY_MS = 10_000;
const TIMEOUT_MS = 30 * 60_000;

function mergeFinding(state: MergeState, base: string): Finding | null {
  const policy = mergeGateStatePolicy(state);
  if (policy.kind === "mergeable") return null;
  return makeFinding("merge", {
    disposition: policy.disposition,
    // A human decides: the fixes here (rebase, force-push, marking ready) change the PR itself,
    // not just files, so they should not run unattended.
    action: "ask-user",
    title:
      policy.kind === "blocking"
        ? `PR is not mergeable (${state})`
        : `Merge readiness is not settled (${state})`,
    detail: policy.kind === "blocking" ? policy.detail(base) : policy.detail(),
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
    display: { group: "PR gate", label: "Merge" },
    consumes: [pullRequest],
    resume: "reconcile",
    async run(ctx: Ctx) {
      const pr = ctx.read(pullRequest);
      // Bind so the pollers keep their provider `this` when called detached below.
      const getMergeState = ctx.gitProvider.getMergeState.bind(ctx.gitProvider);
      const canBypassMerge = ctx.gitProvider.canBypassMerge?.bind(ctx.gitProvider);

      // When a blocking state is one a bypass actor could merge through, ask the host whether *this*
      // user may. A maintainer who can bypass shouldn't be nagged about a rule they can override;
      // for everyone else (and for genuinely unmergeable states) the finding stands.
      async function bypassPermitted(state: MergeState): Promise<boolean> {
        if (canBypassMerge === undefined || !isBypassEligibleMergeState(state)) return false;
        try {
          return await canBypassMerge(pr.base);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.log(`merge-gate: could not determine bypass permission: ${message}`);
          return false;
        }
      }

      let latestState: MergeState = "unknown";
      const result = await executeRoundLoop(ctx, {
        stepName: "merge-gate",
        async check() {
          try {
            latestState = await ctx.until(getMergeState(pr.number), {
              every: EVERY_MS,
              timeout: TIMEOUT_MS,
            });
          } catch (error) {
            if (error instanceof TimeoutError) return { findings: [timeoutFinding(pr.number)] };
            throw error;
          }
          const finding = mergeFinding(latestState, pr.base);
          const bypassed = finding !== null && (await bypassPermitted(latestState));
          ctx.log(
            `merge: ${latestState}${
              isMergeGateMergeable(latestState)
                ? " (mergeable)"
                : bypassed
                  ? " (blocked, but you may bypass)"
                  : ""
            }`,
          );
          return { findings: bypassed ? [] : finding ? [finding] : [] };
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
