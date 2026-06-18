// Forge — the external code-host Provider (GitHub first). The canonical
// dev-lifecycle entities (PullRequest, CheckRun, ReviewThread, mergeable) live
// here in core as first-class types; a host adapter maps a specific Forge onto
// them. Reads are hybrid: getPullRequest returns a full snapshot for
// reconstruction, getChecks is the cheap, pollable call the ci-wait loop drives.

import type { Pending } from "../pending.ts";

export type Mergeable = "mergeable" | "conflicted" | "unknown";

/** The repo owner's aggregate review verdict on a PR; `null` when no review has been submitted. */
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | null;

export interface CheckRun {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "neutral" | "cancelled" | null;
}

/** 👍/👎 tallies on a single comment; the thread root's reactions carry the ack signal. */
export interface Reactions {
  readonly thumbsUp: number;
  readonly thumbsDown: number;
}

export interface ReviewComment {
  readonly author: string;
  readonly body: string;
  readonly reactions: Reactions;
  readonly isMine?: boolean;
}

export interface ReviewThread {
  readonly id: string;
  readonly path?: string;
  /** Anchor line in the file; absent for thread-less/general comments. */
  readonly line?: number;
  /** Root comment body — may carry tml's `tml:finding` marker. */
  readonly body: string;
  readonly resolved: boolean;
  /** GitHub marks a thread outdated once a later commit moved the lines it anchored to. */
  readonly isOutdated?: boolean;
  readonly comments: ReviewComment[];
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
  /** The owner's aggregate review verdict — respected by the merge gate. */
  readonly reviewDecision: ReviewDecision;
  /** SHA of the PR's head commit — what `review` anchors its threads and resume marker to. */
  readonly headSha: string;
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
  /** Idempotency hook: is there already a PR for this head branch? */
  findPullRequest(head: string): Promise<PullRequest | null>;
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequest>;
  /** Full snapshot, for reconstructing Run state from the Forge. */
  getPullRequest(prNumber: number): Promise<PullRequest>;
  /** Cheap and pollable — the ci-wait loop calls this through `until`. */
  getChecks(prNumber: number): Pending<CheckRun[]>;

  /** Replace the PR body — used for the delimited `tml:review` block. */
  updatePullRequestBody(input: { prNumber: number; body: string }): Promise<void>;
  /** Post a new line-anchored review thread (tml's own finding), anchored to `commitSha`. */
  createReviewThread(input: {
    prNumber: number;
    path: string;
    line: number;
    body: string;
    commitSha: string;
  }): Promise<void>;
  /** Reply to any existing thread (tml's, a human's, a bot's). */
  replyToThread(input: { threadId: string; body: string }): Promise<void>;
  /** Resolve a thread tml is allowed to resolve (its own). */
  resolveThread(threadId: string): Promise<void>;
  /** Submit a COMMENT review tied to a commit — the "don't re-review" resume marker. */
  submitReview(input: { prNumber: number; commitSha: string; body: string }): Promise<void>;
  /** SHA of tml's most recent submitted review, or `null` if none. */
  lastReviewedSha(prNumber: number): Promise<string | null>;
}
