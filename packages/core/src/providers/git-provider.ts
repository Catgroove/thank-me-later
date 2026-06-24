// GitProvider - the external code-host Provider (GitHub first). The canonical
// base PR/CI lifecycle entities (PullRequest, CheckRun, mergeable) live here in
// core as first-class types; a host adapter maps a specific Git provider onto
// them. Reads are hybrid: getPullRequest returns a full base snapshot for
// reconstruction, getChecks is the cheap, pollable call the ci-wait loop drives.
// PR comments and review threads are intentionally out of this base surface;
// post-PR conversation reconciliation is a later, separate provider extension.

import type { Pending } from "../pending.ts";

export type Mergeable = "mergeable" | "conflicted" | "unknown";

// The PR's overall merge readiness, derived by the host from every gating factor at once:
// merge conflicts, branch protection, required reviews, and required status checks. This is the
// host's own verdict, distinct from `mergeable` (which is conflicts only). `clean`/`has_hooks`/
// `unstable` all permit merging; `behind` (out of date with base), `dirty` (conflict), `blocked`
// (a required review or status check is unmet), and `draft` do not; `unknown` means the host has
// not finished computing it yet (poll again). Note `blocked`/`unstable` only reflect CI when the
// repo's branch protection makes those checks required - the CI gate must not lean on this alone.
export type MergeableMergeState = "clean" | "has_hooks" | "unstable";
export type BlockingMergeState = "behind" | "dirty" | "blocked" | "draft";
export type UnsettledMergeState = "unknown";
export type MergeState = MergeableMergeState | BlockingMergeState | UnsettledMergeState;
export type MergeStateKind = "mergeable" | "blocking" | "unsettled";

export function mergeStateKind(state: MergeState): MergeStateKind {
  switch (state) {
    case "clean":
    case "has_hooks":
    case "unstable":
      return "mergeable";
    case "behind":
    case "dirty":
    case "blocked":
    case "draft":
      return "blocking";
    case "unknown":
      return "unsettled";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function isMergeable(state: MergeState): state is MergeableMergeState {
  return mergeStateKind(state) === "mergeable";
}

export interface CheckRun {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "neutral" | "cancelled" | null;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed" | "merged";
  readonly mergeable: Mergeable;
  /** The host's overall merge-readiness verdict; the merge gate polls this to a terminal value. */
  readonly mergeStateStatus: MergeState;
  readonly checks: CheckRun[];
}

export interface OpenPullRequestInput {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface GitProvider {
  /** Idempotency hook: is there already a PR for this head branch? */
  findPullRequest(head: string): Promise<PullRequest | null>;
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequest>;
  /** Full base snapshot, for reconstructing Run state from the Git provider. */
  getPullRequest(prNumber: number): Promise<PullRequest>;
  /** Idempotently replace or patch the PR body according to the caller's generated text policy. */
  updatePullRequestBody(input: { prNumber: number; body: string }): Promise<void>;
  /** Cheap and pollable — the ci-wait loop calls this through `until`. */
  getChecks(prNumber: number): Pending<CheckRun[]>;
  /** Merge-readiness poller; settles once the host's {@link MergeState} leaves `unknown`. */
  getMergeState(prNumber: number): Pending<MergeState>;
  /** Optional host-specific CI log retrieval for failed checks. */
  getFailedCheckLogs?(input: { prNumber: number; checkNames?: string[] }): Promise<string>;
}
