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

/** Full snapshot: PR fields + mergeable + checks + resolvable review threads. */
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
      ${ROLLUP_SELECTION}
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          comments(first: 100) { nodes { author { login } body } }
        }
      }
    }
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

/** Resolve a PR number for a head branch (idempotency hook); `--json number` only. */
export function prListArgs(head: string): string[] {
  return ["pr", "list", "--head", head, "--state", "all", "--json", "number"];
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
