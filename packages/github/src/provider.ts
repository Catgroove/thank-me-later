// createGitHubProvider — composes the `gh` runner, the argv/GraphQL builders, and the
// pure mappers into core's `GitProvider`. The provider stays thin: every method runs a
// builder through `run`, parses JSON, and hands it to a mapper. The only state is
// the (injectable) runner.

import type { CheckRun, GitProvider, OpenPullRequestInput, Pending, PullRequest } from "@tml/core";

import { defaultRunner, type GhRunner } from "./gh.ts";
import {
  type ChecksData,
  type GhGraphQlResponse,
  type GhPrListRow,
  mapChecks,
  mapPullRequest,
  type SnapshotData,
} from "./map.ts";
import { checksArgs, prCreateArgs, prEditBodyArgs, prListArgs, snapshotArgs } from "./queries.ts";

export interface GitHubProviderOptions {
  /** Override the `gh` runner; tests inject a fake returning canned JSON. */
  readonly run?: GhRunner;
}

/** Parse the PR number out of the URL `gh pr create` prints on stdout. */
function parsePrNumber(out: string): number {
  const match = out.trim().match(/\/pull\/(\d+)/);
  if (match === null) {
    throw new Error(`could not parse a PR number from gh output: ${out.trim()}`);
  }
  return Number(match[1]);
}

export function createGitHubProvider(cwd: string, opts: GitHubProviderOptions = {}): GitProvider {
  const run = opts.run ?? defaultRunner(cwd);

  async function getPullRequest(prNumber: number): Promise<PullRequest> {
    const res = JSON.parse(await run(snapshotArgs(prNumber))) as GhGraphQlResponse<SnapshotData>;
    return mapPullRequest(res.data.repository.pullRequest);
  }

  return {
    // Idempotency hook: list resolves the number, then reuse the snapshot. Prefer an open PR when
    // the same head branch has older closed/merged PRs, so callers don't mistake it for spent.
    async findPullRequest(head: string): Promise<PullRequest | null> {
      const rows = JSON.parse(await run(prListArgs(head))) as GhPrListRow[];
      const row = rows.find((r) => r.state.toUpperCase() === "OPEN") ?? rows[0];
      return row === undefined ? null : getPullRequest(row.number);
    },

    async openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
      const out = await run(prCreateArgs(input));
      return getPullRequest(parsePrNumber(out));
    },

    getPullRequest,

    async updatePullRequestBody(input: { prNumber: number; body: string }): Promise<void> {
      await run(prEditBodyArgs(input));
    },

    // Cheap, pollable: settles once no run is queued/in_progress (an empty set
    // settles immediately). The consuming step decides pass/fail.
    getChecks(prNumber: number): Pending<CheckRun[]> {
      return {
        async poll() {
          const res = JSON.parse(await run(checksArgs(prNumber))) as GhGraphQlResponse<ChecksData>;
          const checks = mapChecks(res.data.repository.pullRequest.commits);
          const pending = checks.some((c) => c.status === "queued" || c.status === "in_progress");
          return pending ? { done: false } : { done: true, value: checks };
        },
      };
    },

    getMergeability(prNumber: number) {
      return {
        async poll() {
          const pr = await getPullRequest(prNumber);
          return pr.mergeable === "unknown" ? { done: false } : { done: true, value: pr.mergeable };
        },
      };
    },
  };
}
