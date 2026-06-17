// Captured `gh` JSON responses, as typed consts, so the suite is hermetic.
//
// Refresh against a real repo with:
//   gh pr list --head <branch> --state all --json number,state
//   gh api graphql -F owner=<o> -F repo=<r> -F number=<n> -f query="$SNAPSHOT_QUERY"
//   gh api graphql -F owner=<o> -F repo=<r> -F number=<n> -f query="$CHECKS_QUERY"
//   gh pr create --head <branch> --base main --title t --body b   (prints the PR URL)
// The query strings live in src/queries.ts.

import type {
  ChecksData,
  GhCheckNode,
  GhGraphQlResponse,
  GhPrListRow,
  GhPullRequestNode,
  GhRestReviewComment,
  GhReviewThreadNode,
  LastReviewData,
  PrIdData,
  SnapshotData,
} from "../src/map.ts";

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

/** A conclusion outside core's union — must coarsen to `neutral`. */
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

// --- Review threads -------------------------------------------------------------

/** No reactions on a comment — the common case. */
const noReactions = { reactionGroups: [] as const };

export const threadUnresolved: GhReviewThreadNode = {
  id: "RT_unresolved",
  isResolved: false,
  isOutdated: false,
  path: "src/app.ts",
  line: 12,
  comments: {
    nodes: [
      { author: { login: "reviewer" }, body: "nit: rename this", ...noReactions },
      { author: { login: "author" }, body: "done", ...noReactions },
    ],
  },
};

export const threadResolved: GhReviewThreadNode = {
  id: "RT_resolved",
  isResolved: true,
  isOutdated: false,
  path: null,
  line: null,
  comments: {
    nodes: [{ author: null, body: "general comment", ...noReactions }],
  },
};

/** A thumbs-up'd thread root — exercises the reaction mapping. */
export const threadThumbsUp: GhReviewThreadNode = {
  id: "RT_thumbsup",
  isResolved: false,
  isOutdated: true,
  path: "src/x.ts",
  line: 3,
  comments: {
    nodes: [
      {
        author: { login: "tml" },
        body: "<!-- tml:finding key=abc --> consider extracting this",
        reactionGroups: [
          { content: "THUMBS_UP", reactors: { totalCount: 1 } },
          { content: "THUMBS_DOWN", reactors: { totalCount: 0 } },
        ],
      },
    ],
  },
};

// --- Full PR snapshots ----------------------------------------------------------

function snapshot(node: GhPullRequestNode): GhGraphQlResponse<SnapshotData> {
  return { data: { repository: { pullRequest: node } } };
}

export const prOpen: GhPullRequestNode = {
  number: 42,
  url: "https://github.com/acme/widget/pull/42",
  headRefName: "feat/x",
  baseRefName: "main",
  title: "Add x",
  body: "Does x.",
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  headRefOid: "headsha000000000000000000000000000000aaa",
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: { contexts: { nodes: [checkSuccess, statusContextSuccess] } },
        },
      },
    ],
  },
  reviewThreads: { nodes: [threadUnresolved, threadResolved] },
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
  reviewDecision: "CHANGES_REQUESTED",
  headRefOid: "headsha000000000000000000000000000000bbb",
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [checkFailure] } } } }] },
  reviewThreads: { nodes: [] },
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
  reviewDecision: null,
  headRefOid: "headsha000000000000000000000000000000ccc",
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  reviewThreads: { nodes: [] },
};

export const snapshotOpenResponse = snapshot(prOpen);
export const snapshotConflictedResponse = snapshot(prConflicted);
export const snapshotMergedResponse = snapshot(prMerged);

// --- Checks-only query responses (getChecks poll) -------------------------------

function checks(nodes: readonly GhCheckNode[]): GhGraphQlResponse<ChecksData> {
  return {
    data: {
      repository: {
        pullRequest: {
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
        },
      },
    },
  };
}

export const checksAllDone = checks([checkSuccess, statusContextSuccess]);
export const checksPending = checks([checkSuccess, checkInProgress]);
export const checksWithFailure = checks([checkSuccess, checkFailure]);
export const checksEmpty: GhGraphQlResponse<ChecksData> = {
  data: {
    repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } },
  },
};

// --- `gh pr list` rows ----------------------------------------------------------

export const prListHit: GhPrListRow[] = [{ number: 42, state: "OPEN" }];
export const prListEmpty: GhPrListRow[] = [];

// --- `gh pr create` stdout ------------------------------------------------------

export const prCreateOutput = "https://github.com/acme/widget/pull/42\n";

// --- Thread / review mutation + lookup responses --------------------------------

export const prIdResponse: GhGraphQlResponse<PrIdData> = {
  data: { repository: { pullRequest: { id: "PR_node_42" } } },
};

/** Viewer reviewed twice (newest = resume marker); a trailing PENDING review must be ignored. */
export const lastReviewResponse: GhGraphQlResponse<LastReviewData> = {
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: [
            { viewerDidAuthor: true, state: "COMMENTED", commit: { oid: "oldsha" } },
            { viewerDidAuthor: false, state: "COMMENTED", commit: { oid: "someoneelse" } },
            { viewerDidAuthor: true, state: "COMMENTED", commit: { oid: "newsha" } },
            { viewerDidAuthor: true, state: "PENDING", commit: { oid: "pendingsha" } },
          ],
        },
      },
    },
  },
};

export const lastReviewEmpty: GhGraphQlResponse<LastReviewData> = {
  data: { repository: { pullRequest: { reviews: { nodes: [] } } } },
};

/** A REST review comment as returned by `POST /pulls/{n}/comments`. */
export const restReviewComment: GhRestReviewComment = {
  node_id: "PRRC_new",
  path: "src/x.ts",
  line: 9,
  body: "<!-- tml:finding key=k1 --> detail",
  user: { login: "tml" },
};
