// Pure mapping layer: GitHub `gh` JSON -> core GitProvider entities. No `gh`, no `cwd`,
// no I/O - every function takes already-parsed JSON and returns a core entity, so
// the enum tables here are the unit of correctness (see test/map.test.ts).
//
// This file owns the input contract: the raw shapes of `gh pr view --json ...` and
// `gh pr list` output that the provider feeds in.

import type { CheckRun, Mergeable, MergeState, PullRequest } from "@tml/core";

// --- Raw `gh` response shapes (pre-mapping) -------------------------------------

/** A check from the PR status-check rollup. */
export interface GhCheckRunNode {
  readonly __typename: "CheckRun";
  readonly name: string;
  /** QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED */
  readonly status: string;
  /** SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ... | null */
  readonly conclusion: string | null;
  /** GitHub Actions job URL, when available. */
  readonly detailsUrl?: string;
}

/** A legacy commit status surfaced in the same rollup. */
export interface GhStatusContextNode {
  readonly __typename: "StatusContext";
  readonly context: string;
  /** EXPECTED | ERROR | FAILURE | PENDING | SUCCESS */
  readonly state: string;
  /** External status URL, when available. */
  readonly targetUrl?: string;
}

export type GhCheckNode = GhCheckRunNode | GhStatusContextNode;

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
  /** CLEAN | HAS_HOOKS | UNSTABLE | BEHIND | DIRTY | BLOCKED | DRAFT | UNKNOWN */
  readonly mergeStateStatus: string;
  readonly statusCheckRollup: readonly GhCheckNode[] | null;
}

/** `gh pr view --json statusCheckRollup` response for cheap check polling. */
export interface GhChecksView {
  readonly statusCheckRollup: readonly GhCheckNode[] | null;
}

/** A row of `gh pr list --json number,state`. */
export interface GhPrListRow {
  readonly number: number;
  /** OPEN | CLOSED | MERGED */
  readonly state: string;
}

// --- Mappers (raw JSON -> core entities) -----------------------------------------

/** GitHub PR state -> core. Unknown states coarsen to `open` (never observed live). */
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

export function mapMergeStateStatus(raw: string): MergeState {
  switch (raw) {
    case "CLEAN":
      return "clean";
    case "HAS_HOOKS":
      return "has_hooks";
    case "UNSTABLE":
      return "unstable";
    case "BEHIND":
      return "behind";
    case "DIRTY":
      return "dirty";
    case "BLOCKED":
      return "blocked";
    case "DRAFT":
      return "draft";
    default:
      return "unknown"; // includes "UNKNOWN" and any unobserved state - poll again
  }
}

/** CheckRun.status enum -> core. Unknown statuses coarsen to `queued` (keep polling). */
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

/** CheckRun.conclusion enum -> core. Anything outside the core union coarsens to `neutral`. */
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
      return "neutral"; // ACTION_REQUIRED | TIMED_OUT | STALE | SKIPPED | STARTUP_FAILURE | ...
  }
}

/** A legacy StatusContext `state` -> a CheckRun status. */
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

/** A legacy StatusContext `state` -> a CheckRun conclusion. */
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

/** Map a PR status-check rollup; empty when `gh` returns no rollup. */
export function mapChecks(rollup: readonly GhCheckNode[] | null | undefined): CheckRun[] {
  return (rollup ?? []).map(mapCheckNode);
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
    mergeStateStatus: mapMergeStateStatus(node.mergeStateStatus),
    checks: mapChecks(node.statusCheckRollup),
  };
}
