// Forge — the external code-host Provider (GitHub first; ADR-0005). The canonical
// dev-lifecycle entities (PullRequest, CheckRun, ReviewThread, mergeable) live
// here in core as first-class types; a host adapter maps a specific Forge onto
// them. Reads are hybrid: getPullRequest returns a full snapshot for
// reconstruction, getChecks is the cheap, pollable call the ci-wait loop drives.

import type { Pending } from "../pending.ts";

export type Mergeable = "mergeable" | "conflicted" | "unknown";

export interface CheckRun {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "neutral" | "cancelled" | null;
}

export interface ReviewThread {
  readonly id: string;
  readonly path?: string;
  readonly body: string;
  readonly resolved: boolean;
  readonly comments: { author: string; body: string }[];
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
  readonly threads: ReviewThread[];
}

export interface OpenPullRequestInput {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface Forge {
  /** Idempotency hook (ADR-0004): is there already a PR for this head branch? */
  findPullRequest(head: string): Promise<PullRequest | null>;
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequest>;
  /** Full snapshot, for reconstructing Run state from the Forge. */
  getPullRequest(prNumber: number): Promise<PullRequest>;
  /** Cheap and pollable — the ci-wait loop calls this through `until`. */
  getChecks(prNumber: number): Pending<CheckRun[]>;
}
