// Pure mapping layer: GitHub `gh` JSON → core Forge entities. No `gh`, no `cwd`,
// no I/O — every function takes already-parsed JSON and returns a core entity, so
// the enum tables here are the unit of correctness (see test/map.test.ts).
//
// This file owns the *input contract*: the raw shapes of `gh api graphql` /
// `gh pr list` output that the provider feeds in.

import type { CheckRun, Mergeable, PullRequest, ReviewThread } from "@tml/core";

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

export interface GhReviewThreadNode {
  readonly id: string;
  readonly isResolved: boolean;
  readonly path: string | null;
  readonly comments: {
    readonly nodes: readonly {
      readonly author: { readonly login: string } | null;
      readonly body: string;
    }[];
  };
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

export function mapReviewThread(node: GhReviewThreadNode): ReviewThread {
  const comments = node.comments.nodes.map((c) => ({
    author: c.author?.login ?? "",
    body: c.body,
  }));
  const base = { id: node.id, body: comments[0]?.body ?? "", resolved: node.isResolved, comments };
  return node.path === null ? base : { ...base, path: node.path };
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
    checks: mapChecks(node.commits),
    threads: node.reviewThreads.nodes.map(mapReviewThread),
  };
}
