import { isMergeable, type Finding, type MergeState } from "@tml/core";

interface MergeGateStatePolicy {
  readonly disposition: Finding["disposition"];
  readonly detail: (base: string) => string;
  readonly guidance: (base: string) => string;
}

const mergeGatePolicies = {
  behind: {
    disposition: "blocker",
    detail: (base) =>
      `The branch is behind ${base}; rebase it onto the latest base so it can merge.`,
    guidance: (base) => `rebase the branch onto origin/${base} and push with --force-with-lease.`,
  },
  dirty: {
    disposition: "blocker",
    detail: (base) => `The PR has merge conflicts with ${base}; rebase and resolve them.`,
    guidance: (base) =>
      `rebase onto origin/${base}, resolve every conflict preserving both sides' intent, then ` +
      "push with --force-with-lease.",
  },
  blocked: {
    disposition: "blocker",
    detail: () =>
      "Merging is blocked by branch protection - a required review or status check is unmet.",
    guidance: () =>
      "a required review or status check is unmet; report what is missing - do not try to " +
      "bypass branch protection.",
  },
  draft: {
    disposition: "should-fix",
    detail: () => "The PR is a draft; mark it ready for review before it can merge.",
    guidance: () => "mark the pull request ready for review.",
  },
} satisfies Partial<Record<MergeState, MergeGateStatePolicy>>;

type MergeGateBlockingState = keyof typeof mergeGatePolicies;

function isMergeGateBlockingState(state: MergeState): state is MergeGateBlockingState {
  return Object.hasOwn(mergeGatePolicies, state);
}

export function mergeGateStatePolicy(state: MergeState): MergeGateStatePolicy | null {
  return isMergeGateBlockingState(state) ? mergeGatePolicies[state] : null;
}

export function isMergeGateMergeable(state: MergeState): boolean {
  return isMergeable(state);
}

export function formatMergeGateGuidance(base: string): string {
  return (Object.entries(mergeGatePolicies) as [MergeGateBlockingState, MergeGateStatePolicy][])
    .map(([state, policy]) => `- ${state}: ${policy.guidance(base)}`)
    .join("\n");
}
