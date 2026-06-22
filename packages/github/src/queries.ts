// `gh` argv builders + the GraphQL queries the Git provider runs. Pure: each
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

/** Full base snapshot: PR fields + mergeable + checks. */
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

/** Failed-log lookup query with action run links; not part of the base PullRequest snapshot. */
export const FAILED_CHECK_LINKS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
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

export function prEditBodyArgs(input: { prNumber: number; body: string }): string[] {
  return ["pr", "edit", String(input.prNumber), "--body", input.body];
}

export function snapshotArgs(prNumber: number): string[] {
  return graphqlArgs(SNAPSHOT_QUERY, prNumber);
}

export function checksArgs(prNumber: number): string[] {
  return graphqlArgs(CHECKS_QUERY, prNumber);
}

export function failedCheckLinksArgs(prNumber: number): string[] {
  return graphqlArgs(FAILED_CHECK_LINKS_QUERY, prNumber);
}

export function runViewFailedLogArgs(runId: string): string[] {
  return ["run", "view", runId, "--log-failed"];
}
