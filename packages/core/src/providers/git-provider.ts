// GitProvider - the external code-host Provider (GitHub first). The canonical
// base PR/CI lifecycle entities (PullRequest, CheckRun, mergeable) live here in
// core as first-class types; a host adapter maps a specific Git provider onto
// them. Reads are hybrid: getPullRequest returns a full base snapshot for
// reconstruction, getChecks is the cheap, pollable call the ci-wait loop drives.
// PR comments and review threads are intentionally out of this base surface;
// post-PR conversation reconciliation is a later, separate provider extension.

import type { Pending } from "../pending.ts";

export type Mergeable = "mergeable" | "conflicted" | "unknown";

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
  /** Optional host-specific mergeability poller when a snapshot can initially report unknown. */
  getMergeability?(prNumber: number): Pending<Mergeable>;
  /** Optional host-specific CI log retrieval for failed checks. */
  getFailedCheckLogs?(input: { prNumber: number; checkNames?: string[] }): Promise<string>;
}
