import { isMergeable, type BlockingMergeState, type Finding, type MergeState } from "@tml/core";

interface MergeGateBlockingPolicy {
  readonly kind: "blocking";
  readonly disposition: Finding["disposition"];
  readonly detail: (base: string) => string;
  readonly guidance: (base: string) => string;
}

interface MergeGateUnsettledPolicy {
  readonly kind: "unsettled";
  readonly disposition: Finding["disposition"];
  readonly detail: () => string;
}

type MergeGateStatePolicy =
  | { readonly kind: "mergeable" }
  | MergeGateBlockingPolicy
  | MergeGateUnsettledPolicy;

const mergeablePolicy = { kind: "mergeable" } satisfies MergeGateStatePolicy;

const unsettledPolicy = {
  kind: "unsettled",
  disposition: "should-fix",
  detail: () =>
    "The host returned an unsettled merge state after the merge-readiness poller completed.",
} satisfies MergeGateUnsettledPolicy;

const blockingPolicies = {
  behind: {
    kind: "blocking",
    disposition: "blocker",
    detail: (base) =>
      `The branch is behind ${base}; rebase it onto the latest base so it can merge.`,
    guidance: (base) => `rebase the branch onto origin/${base} and push with --force-with-lease.`,
  },
  dirty: {
    kind: "blocking",
    disposition: "blocker",
    detail: (base) => `The PR has merge conflicts with ${base}; rebase and resolve them.`,
    guidance: (base) =>
      `rebase onto origin/${base}, resolve every conflict preserving both sides' intent, then ` +
      "push with --force-with-lease.",
  },
  blocked: {
    kind: "blocking",
    disposition: "blocker",
    detail: () =>
      "Merging is blocked by branch protection - a required review or status check is unmet.",
    guidance: () =>
      "a required review or status check is unmet; report what is missing - do not try to " +
      "bypass branch protection.",
  },
  draft: {
    kind: "blocking",
    disposition: "should-fix",
    detail: () => "The PR is a draft; mark it ready for review before it can merge.",
    guidance: () => "mark the pull request ready for review.",
  },
} satisfies Record<BlockingMergeState, MergeGateBlockingPolicy>;

export function mergeGateStatePolicy(state: MergeState): MergeGateStatePolicy {
  if (isMergeable(state)) return mergeablePolicy;
  if (state === "unknown") return unsettledPolicy;
  return blockingPolicies[state];
}

export function isMergeGateMergeable(state: MergeState): boolean {
  return isMergeable(state);
}

export function formatMergeGateGuidance(base: string): string {
  return (Object.entries(blockingPolicies) as [BlockingMergeState, MergeGateBlockingPolicy][])
    .map(([state, policy]) => `- ${state}: ${policy.guidance(base)}`)
    .join("\n");
}
