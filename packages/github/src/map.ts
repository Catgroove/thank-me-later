// Pure mapping layer: GitHub `gh` JSON → core Forge entities. No `gh`, no `cwd`,
// no I/O — every function takes already-parsed JSON and returns a core entity, so
// the enum tables here are the unit of correctness (see test/map.test.ts).
//
// This file owns the *input contract*: the raw shapes of `gh api graphql` /
// `gh pr list` output that the provider feeds in.

import type {
  CheckRun,
  Mergeable,
  PullRequest,
  Reactions,
  ReviewComment,
  ReviewDecision,
  ReviewThread,
} from "@tml/core";

// --- Raw `gh` response shapes (pre-mapping) -------------------------------------

/** A check from the GraphQL Checks API. */
export interface GhCheckRunNode {
  readonly __typename: "CheckRun";
  readonly name: string;
  /** QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED */
  readonly status: string;
  /** SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | … | null */
  readonly conclusion: string | null;
}

/** A legacy commit status surfaced in the same rollup. */
export interface GhStatusContextNode {
  readonly __typename: "StatusContext";
  readonly context: string;
  /** EXPECTED | ERROR | FAILURE | PENDING | SUCCESS */
  readonly state: string;
}

export type GhCheckNode = GhCheckRunNode | GhStatusContextNode;

/** A `reactionGroups` entry: the emoji content + how many users reacted with it. */
export interface GhReactionGroup {
  readonly content: string;
  readonly reactors: { readonly totalCount: number };
}

export interface GhReviewCommentNode {
  readonly author: { readonly login: string } | null;
  readonly body: string;
  readonly reactionGroups: readonly GhReactionGroup[];
}

export interface GhReviewThreadNode {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly comments: { readonly nodes: readonly GhReviewCommentNode[] };
}

/** A viewer-authored review, tied to the commit it reviewed (the `lastReviewedSha` source). */
export interface GhReviewNode {
  readonly viewerDidAuthor: boolean;
  /** PENDING | COMMENTED | APPROVED | CHANGES_REQUESTED | DISMISSED */
  readonly state: string;
  readonly commit: { readonly oid: string } | null;
}

/** A review comment returned by the REST `POST /pulls/{n}/comments` endpoint (createReviewThread). */
export interface GhRestReviewComment {
  readonly node_id: string;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
  readonly user: { readonly login: string } | null;
}

/** The last commit on the PR carries the status-check rollup. */
export interface GhCommitNode {
  readonly commit: {
    readonly statusCheckRollup: {
      readonly contexts: { readonly nodes: readonly GhCheckNode[] };
    } | null;
  };
}

export interface GhPullRequestNode {
  readonly number: number;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly title: string;
  readonly body: string;
  /** OPEN | CLOSED | MERGED */
  readonly state: string;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  readonly mergeable: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null */
  readonly reviewDecision: string | null;
  readonly headRefOid: string;
  readonly commits: { readonly nodes: readonly GhCommitNode[] };
  readonly reviewThreads: { readonly nodes: readonly GhReviewThreadNode[] };
}

/** `gh api graphql` wraps the selection under `data`. */
export interface GhGraphQlResponse<T> {
  readonly data: T;
}

/** `data` shape of the full-snapshot query (getPullRequest / findPullRequest). */
export interface SnapshotData {
  readonly repository: { readonly pullRequest: GhPullRequestNode };
}

/** `data` shape of the lighter checks-only query (getChecks poll). */
export interface ChecksData {
  readonly repository: {
    readonly pullRequest: { readonly commits: { readonly nodes: readonly GhCommitNode[] } };
  };
}

/** `data` shape of the PR-node-id lookup (input to the thread/review mutations). */
export interface PrIdData {
  readonly repository: { readonly pullRequest: { readonly id: string } };
}

/** `data` shape of the viewer-reviews query (lastReviewedSha). */
export interface LastReviewData {
  readonly repository: {
    readonly pullRequest: { readonly reviews: { readonly nodes: readonly GhReviewNode[] } };
  };
}

/** A row of `gh pr list --json number,state`. */
export interface GhPrListRow {
  readonly number: number;
  /** OPEN | CLOSED | MERGED */
  readonly state: string;
}

// --- Mappers (raw JSON → core entities) -----------------------------------------

/** GraphQL PR state → core. Unknown states coarsen to `open` (never observed live). */
export function mapState(raw: string): PullRequest["state"] {
  switch (raw) {
    case "CLOSED":
      return "closed";
    case "MERGED":
      return "merged";
    default:
      return "open";
  }
}

export function mapMergeable(raw: string): Mergeable {
  switch (raw) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicted";
    default:
      return "unknown"; // includes "UNKNOWN"
  }
}

/** PR reviewDecision enum → core. Null (no review yet) and unknowns coarsen to `null`. */
export function mapReviewDecision(raw: string | null): ReviewDecision {
  switch (raw) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return null;
  }
}

/** CheckRun.status enum → core. Unknown statuses coarsen to `queued` (keep polling). */
export function mapCheckStatus(raw: string): CheckRun["status"] {
  switch (raw) {
    case "COMPLETED":
      return "completed";
    case "IN_PROGRESS":
      return "in_progress";
    default:
      return "queued"; // QUEUED | WAITING | PENDING | REQUESTED | unknown
  }
}

/** CheckRun.conclusion enum → core. Anything outside the core union coarsens to `neutral`. */
export function mapConclusion(raw: string | null): CheckRun["conclusion"] {
  switch (raw) {
    case null:
      return null;
    case "SUCCESS":
      return "success";
    case "FAILURE":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "NEUTRAL":
      return "neutral";
    default:
      return "neutral"; // ACTION_REQUIRED | TIMED_OUT | STALE | SKIPPED | STARTUP_FAILURE | …
  }
}

/** A legacy StatusContext `state` → a CheckRun status. */
function contextStatus(state: string): CheckRun["status"] {
  switch (state) {
    case "SUCCESS":
    case "FAILURE":
    case "ERROR":
      return "completed";
    case "EXPECTED":
      return "queued";
    default:
      return "in_progress"; // PENDING | unknown
  }
}

/** A legacy StatusContext `state` → a CheckRun conclusion. */
function contextConclusion(state: string): CheckRun["conclusion"] {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    default:
      return null; // PENDING | EXPECTED | unknown
  }
}

export function mapCheckNode(node: GhCheckNode): CheckRun {
  if (node.__typename === "CheckRun") {
    return {
      name: node.name,
      status: mapCheckStatus(node.status),
      conclusion: mapConclusion(node.conclusion),
    };
  }
  return {
    name: node.context,
    status: contextStatus(node.state),
    conclusion: contextConclusion(node.state),
  };
}

/** Pull the rollup contexts off the PR's last commit; empty when there is no rollup. */
export function mapChecks(commits: { readonly nodes: readonly GhCommitNode[] }): CheckRun[] {
  const rollup = commits.nodes[0]?.commit.statusCheckRollup;
  return (rollup?.contexts.nodes ?? []).map(mapCheckNode);
}

/** Tally a comment's `reactionGroups` into 👍/👎 counts; other emoji are ignored. */
export function mapReactions(groups: readonly GhReactionGroup[]): Reactions {
  const count = (content: string) =>
    groups.find((g) => g.content === content)?.reactors.totalCount ?? 0;
  return { thumbsUp: count("THUMBS_UP"), thumbsDown: count("THUMBS_DOWN") };
}

export function mapReviewComment(node: GhReviewCommentNode): ReviewComment {
  return {
    author: node.author?.login ?? "",
    body: node.body,
    reactions: mapReactions(node.reactionGroups),
  };
}

export function mapReviewThread(node: GhReviewThreadNode): ReviewThread {
  const comments = node.comments.nodes.map(mapReviewComment);
  const base: ReviewThread = {
    id: node.id,
    body: comments[0]?.body ?? "",
    resolved: node.isResolved,
    isOutdated: node.isOutdated,
    comments,
  };
  const withPath = node.path === null ? base : { ...base, path: node.path };
  return node.line === null ? withPath : { ...withPath, line: node.line };
}

/** The SHA of the viewer's most recent *submitted* review, or `null` when there is none. A still
 *  PENDING review (e.g. left by an interrupted run) is ignored — only submitted reviews mark a
 *  reviewed head. */
export function mapLastReviewedSha(reviews: readonly GhReviewNode[]): string | null {
  const mine = reviews.filter(
    (r) => r.viewerDidAuthor && r.state !== "PENDING" && r.commit !== null,
  );
  return mine.at(-1)?.commit?.oid ?? null;
}

/** Map a REST review comment into a (single-comment, unresolved) ReviewThread. */
export function mapRestReviewComment(c: GhRestReviewComment): ReviewThread {
  const comment: ReviewComment = {
    author: c.user?.login ?? "",
    body: c.body,
    reactions: { thumbsUp: 0, thumbsDown: 0 },
  };
  const base: ReviewThread = { id: c.node_id, body: c.body, resolved: false, comments: [comment] };
  const withPath = c.path === "" ? base : { ...base, path: c.path };
  return c.line === null ? withPath : { ...withPath, line: c.line };
}

export function mapPullRequest(node: GhPullRequestNode): PullRequest {
  return {
    number: node.number,
    url: node.url,
    head: node.headRefName,
    base: node.baseRefName,
    title: node.title,
    body: node.body,
    state: mapState(node.state),
    mergeable: mapMergeable(node.mergeable),
    reviewDecision: mapReviewDecision(node.reviewDecision),
    headSha: node.headRefOid,
    checks: mapChecks(node.commits),
    threads: node.reviewThreads.nodes.map(mapReviewThread),
  };
}
