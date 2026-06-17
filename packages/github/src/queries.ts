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
        }
      }
    }
  }
}`;

/** A review comment with its 👍/👎 reaction tallies (the root comment carries the ack signal). */
const COMMENT_SELECTION = `nodes {
  author { login }
  body
  reactionGroups { content reactors { totalCount } }
}`;

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
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) { ${COMMENT_SELECTION} }
        }
      }
    }
  }
}`;

/** The PR's GraphQL node id — needed as input to the thread/review mutations. */
export const PR_ID_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
}`;

/** Viewer-authored reviews newest-last, each tied to the commit it reviewed (the resume marker). */
export const LAST_REVIEW_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 50) { nodes { viewerDidAuthor commit { oid } } }
    }
  }
}`;

/** Post a new line-anchored review thread; returns the created thread for mapping back. */
export const ADD_THREAD_MUTATION = `mutation($prId: ID!, $body: String!, $path: String!, $line: Int!) {
  addPullRequestReviewThread(input: {
    pullRequestId: $prId, body: $body, path: $path, line: $line, side: RIGHT, subjectType: LINE
  }) {
    thread {
      id
      isResolved
      isOutdated
      path
      line
      comments(first: 1) { ${COMMENT_SELECTION} }
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

function graphqlArgs(query: string, prNumber: number): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    `number=${prNumber}`,
  ];
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
  return graphqlArgs(SNAPSHOT_QUERY, prNumber);
}

export function checksArgs(prNumber: number): string[] {
  return graphqlArgs(CHECKS_QUERY, prNumber);
}

export function prNodeIdArgs(prNumber: number): string[] {
  return graphqlArgs(PR_ID_QUERY, prNumber);
}

export function lastReviewArgs(prNumber: number): string[] {
  return graphqlArgs(LAST_REVIEW_QUERY, prNumber);
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

export function createThreadArgs(input: {
  prId: string;
  path: string;
  line: number;
  body: string;
}): string[] {
  return mutationArgs(ADD_THREAD_MUTATION, [
    { name: "prId", value: input.prId },
    { name: "body", value: input.body },
    { name: "path", value: input.path },
    { name: "line", value: String(input.line), numeric: true },
  ]);
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
