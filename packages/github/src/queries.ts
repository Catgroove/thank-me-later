// `gh` argv builders + the GraphQL queries the Forge provider runs. Pure: each
// builder returns the argv array passed to a `GhRunner`. `gh` expands the
// `{owner}`/`{repo}` placeholders in `-F` values from the repo in `cwd`, so the
// queries take them as variables without a separate repo-resolution call.

import type { OpenPullRequestInput } from "@tml/core";

/** The status-check rollup off the PR's last commit; shared by both reads. */
const ROLLUP_SELECTION = `commits(last: 1) {
  nodes {
    commit {
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun { name status conclusion }
            ... on StatusContext { context state }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}`;

/** Pagination fields shared by GraphQL connections. */
const PAGE_INFO_SELECTION = `pageInfo { hasNextPage endCursor }`;

/** A review comment with its 👍/👎 reaction tallies (the root comment carries the ack signal). */
const COMMENT_SELECTION = `nodes {
  author { login }
  body
  viewerDidAuthor
  reactionGroups { content reactors { totalCount } }
}`;

const COMMENT_CONNECTION_SELECTION = `${COMMENT_SELECTION}
  ${PAGE_INFO_SELECTION}`;

const REVIEW_THREADS_SELECTION = `nodes {
  id
  isResolved
  isOutdated
  path
  line
  comments(first: 100) { ${COMMENT_CONNECTION_SELECTION} }
}
${PAGE_INFO_SELECTION}`;

/** Full snapshot: PR fields + mergeable + review decision + head sha + checks + review threads. */
export const SNAPSHOT_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      url
      headRefName
      baseRefName
      title
      body
      state
      mergeable
      reviewDecision
      headRefOid
      ${ROLLUP_SELECTION}
      reviewThreads(first: 100) { ${REVIEW_THREADS_SELECTION} }
    }
  }
}`;

export const REVIEW_THREADS_PAGE_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $threadsCursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $threadsCursor) { ${REVIEW_THREADS_SELECTION} }
    }
  }
}`;

export const REVIEW_THREAD_COMMENTS_PAGE_QUERY = `query($threadId: ID!, $commentsCursor: String!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $commentsCursor) { ${COMMENT_CONNECTION_SELECTION} }
    }
  }
}`;

export const CHECK_CONTEXTS_PAGE_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $checksCursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $checksCursor) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }
  }
}`;

/** The PR's GraphQL node id — needed as input to the thread/review mutations. */
export const PR_ID_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
}`;

/** Viewer-authored reviews newest-last, with enough fields to identify submitted tml markers. */
export const LAST_REVIEW_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 100) {
        nodes { viewerDidAuthor state body commit { oid } }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

export const LAST_REVIEWS_PAGE_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $reviewsCursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 100, before: $reviewsCursor) {
        nodes { viewerDidAuthor state body commit { oid } }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

export const ADD_REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

export const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

/** Submit a COMMENT review tied to a commit — the only review event a self-author may post. */
export const ADD_REVIEW_MUTATION = `mutation($prId: ID!, $commit: GitObjectID!, $body: String!) {
  addPullRequestReview(input: { pullRequestId: $prId, commitOID: $commit, event: COMMENT, body: $body }) {
    pullRequestReview { id }
  }
}`;

/** Lighter checks-only query the `getChecks` poll loop drives. */
export const CHECKS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      ${ROLLUP_SELECTION}
    }
  }
}`;

function graphqlArgs(
  query: string,
  vars: readonly { name: string; value: string; numeric?: boolean }[],
  repoVars = true,
): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  if (repoVars) args.push("-F", "owner={owner}", "-F", "repo={repo}");
  for (const v of vars) args.push(v.numeric ? "-F" : "-f", `${v.name}=${v.value}`);
  return args;
}

function prGraphqlArgs(query: string, prNumber: number): string[] {
  return graphqlArgs(query, [{ name: "number", value: String(prNumber), numeric: true }]);
}

/** Resolve PR numbers for a head branch (idempotency hook); include state to prefer an open PR. */
export function prListArgs(head: string): string[] {
  return ["pr", "list", "--head", head, "--state", "all", "--json", "number,state"];
}

export function prCreateArgs(input: OpenPullRequestInput): string[] {
  return [
    "pr",
    "create",
    "--head",
    input.head,
    "--base",
    input.base,
    "--title",
    input.title,
    "--body",
    input.body,
  ];
}

export function snapshotArgs(prNumber: number): string[] {
  return prGraphqlArgs(SNAPSHOT_QUERY, prNumber);
}

export function reviewThreadsPageArgs(prNumber: number, cursor: string): string[] {
  return graphqlArgs(REVIEW_THREADS_PAGE_QUERY, [
    { name: "number", value: String(prNumber), numeric: true },
    { name: "threadsCursor", value: cursor },
  ]);
}

export function reviewThreadCommentsPageArgs(threadId: string, cursor: string): string[] {
  return graphqlArgs(
    REVIEW_THREAD_COMMENTS_PAGE_QUERY,
    [
      { name: "threadId", value: threadId },
      { name: "commentsCursor", value: cursor },
    ],
    false,
  );
}

export function checkContextsPageArgs(prNumber: number, cursor: string): string[] {
  return graphqlArgs(CHECK_CONTEXTS_PAGE_QUERY, [
    { name: "number", value: String(prNumber), numeric: true },
    { name: "checksCursor", value: cursor },
  ]);
}

export function checksArgs(prNumber: number): string[] {
  return prGraphqlArgs(CHECKS_QUERY, prNumber);
}

export function prNodeIdArgs(prNumber: number): string[] {
  return prGraphqlArgs(PR_ID_QUERY, prNumber);
}

export function lastReviewArgs(prNumber: number): string[] {
  return prGraphqlArgs(LAST_REVIEW_QUERY, prNumber);
}

export function lastReviewsPageArgs(prNumber: number, cursor: string): string[] {
  return graphqlArgs(LAST_REVIEWS_PAGE_QUERY, [
    { name: "number", value: String(prNumber), numeric: true },
    { name: "reviewsCursor", value: cursor },
  ]);
}

/** Build `gh api graphql` argv for a mutation; string vars use `-f`, numeric vars `-F`. */
function mutationArgs(
  query: string,
  vars: readonly { name: string; value: string; numeric?: boolean }[],
): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const v of vars) args.push(v.numeric ? "-F" : "-f", `${v.name}=${v.value}`);
  return args;
}

/**
 * Post a new line-anchored review comment via the REST API. Unlike GraphQL's
 * `addPullRequestReviewThread` (which adds to a *pending* review and would collide with our
 * separate review-submit), a REST review comment is published immediately and starts its own
 * resolvable thread. `commit_id` anchors it to the reviewed head; `line`/`side` to the new side.
 */
export function createReviewCommentArgs(input: {
  prNumber: number;
  path: string;
  line: number;
  body: string;
  commitSha: string;
}): string[] {
  return [
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/pulls/${input.prNumber}/comments`,
    "-f",
    `body=${input.body}`,
    "-f",
    `commit_id=${input.commitSha}`,
    "-f",
    `path=${input.path}`,
    "-F",
    `line=${input.line}`,
    "-f",
    "side=RIGHT",
  ];
}

export function replyThreadArgs(input: { threadId: string; body: string }): string[] {
  return mutationArgs(ADD_REPLY_MUTATION, [
    { name: "threadId", value: input.threadId },
    { name: "body", value: input.body },
  ]);
}

export function resolveThreadArgs(threadId: string): string[] {
  return mutationArgs(RESOLVE_MUTATION, [{ name: "threadId", value: threadId }]);
}

export function submitReviewArgs(input: { prId: string; commit: string; body: string }): string[] {
  return mutationArgs(ADD_REVIEW_MUTATION, [
    { name: "prId", value: input.prId },
    { name: "commit", value: input.commit },
    { name: "body", value: input.body },
  ]);
}

/** Replace the PR body via `gh pr edit` (REST under the hood) — keeps human prose, swaps the block. */
export function prEditBodyArgs(prNumber: number, body: string): string[] {
  return ["pr", "edit", String(prNumber), "--body", body];
}
