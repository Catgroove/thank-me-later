// Captured `gh` JSON responses, as typed consts, so the suite is hermetic.
//
// Refresh against a real repo with:
//   gh pr list --head <branch> --state all --json number,state
//   gh pr view <n> --json number,url,headRefName,baseRefName,title,body,state,mergeable,statusCheckRollup
//   gh pr view <n> --json statusCheckRollup
//   gh pr create --head <branch> --base main --title t --body b   (prints the PR URL)

import type { GhCheckNode, GhChecksView, GhPrListRow, GhPullRequestNode } from "../src/map.ts";

// --- Check rollup nodes ---------------------------------------------------------

export const checkSuccess: GhCheckNode = {
  __typename: "CheckRun",
  name: "build",
  status: "COMPLETED",
  conclusion: "SUCCESS",
};

export const checkFailure: GhCheckNode = {
  __typename: "CheckRun",
  name: "test",
  status: "COMPLETED",
  conclusion: "FAILURE",
};

export const checkInProgress: GhCheckNode = {
  __typename: "CheckRun",
  name: "lint",
  status: "IN_PROGRESS",
  conclusion: null,
};

export const checkQueued: GhCheckNode = {
  __typename: "CheckRun",
  name: "deploy",
  status: "QUEUED",
  conclusion: null,
};

/** A conclusion outside core's union - must coarsen to `neutral`. */
export const checkSkipped: GhCheckNode = {
  __typename: "CheckRun",
  name: "optional",
  status: "COMPLETED",
  conclusion: "SKIPPED",
};

/** Legacy commit status, success. */
export const statusContextSuccess: GhCheckNode = {
  __typename: "StatusContext",
  context: "ci/legacy",
  state: "SUCCESS",
};

/** Legacy commit status, still pending. */
export const statusContextPending: GhCheckNode = {
  __typename: "StatusContext",
  context: "ci/slow",
  state: "PENDING",
};

// --- Full PR snapshots ----------------------------------------------------------

export const prOpen: GhPullRequestNode = {
  number: 42,
  url: "https://github.com/acme/widget/pull/42",
  headRefName: "feat/x",
  baseRefName: "main",
  title: "Add x",
  body: "Does x.",
  state: "OPEN",
  mergeable: "MERGEABLE",
  statusCheckRollup: [checkSuccess, statusContextSuccess],
};

export const prConflicted: GhPullRequestNode = {
  number: 43,
  url: "https://github.com/acme/widget/pull/43",
  headRefName: "feat/y",
  baseRefName: "main",
  title: "Add y",
  body: "Does y.",
  state: "OPEN",
  mergeable: "CONFLICTING",
  statusCheckRollup: [checkFailure],
};

export const prMerged: GhPullRequestNode = {
  number: 44,
  url: "https://github.com/acme/widget/pull/44",
  headRefName: "feat/z",
  baseRefName: "main",
  title: "Add z",
  body: "Does z.",
  state: "MERGED",
  mergeable: "UNKNOWN",
  statusCheckRollup: null,
};

export const snapshotOpenResponse = prOpen;
export const snapshotConflictedResponse = prConflicted;
export const snapshotMergedResponse = prMerged;

// --- Checks-only `gh pr view` responses (getChecks poll) -------------------------

function checks(nodes: readonly GhCheckNode[]): GhChecksView {
  return { statusCheckRollup: nodes };
}

export const checksAllDone = checks([checkSuccess, statusContextSuccess]);
export const checksPending = checks([checkSuccess, checkInProgress]);
export const checksWithFailure = checks([checkSuccess, checkFailure]);
export const checksEmpty: GhChecksView = { statusCheckRollup: null };

// --- `gh pr list` rows ----------------------------------------------------------

export const prListHit: GhPrListRow[] = [{ number: 42, state: "OPEN" }];
export const prListEmpty: GhPrListRow[] = [];

// --- `gh pr create` stdout ------------------------------------------------------

export const prCreateOutput = "https://github.com/acme/widget/pull/42\n";
