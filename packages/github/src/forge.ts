// createGitHubForge — composes the `gh` runner, the argv/GraphQL builders, and the
// pure mappers into core's `Forge`. The provider stays thin: every method runs a
// builder through `run`, parses JSON, and hands it to a mapper. The only state is
// the (injectable) runner.

import type {
  CheckRun,
  Forge,
  OpenPullRequestInput,
  Pending,
  PullRequest,
  ReviewThread,
} from "@tml/core";

import { defaultRunner, type GhRunner } from "./gh.ts";
import {
  type ChecksData,
  type GhGraphQlResponse,
  type GhPrListRow,
  type GhRestReviewComment,
  type LastReviewData,
  mapChecks,
  mapLastReviewedSha,
  mapPullRequest,
  mapRestReviewComment,
  type PrIdData,
  type SnapshotData,
} from "./map.ts";
import {
  checksArgs,
  createReviewCommentArgs,
  lastReviewArgs,
  prCreateArgs,
  prEditBodyArgs,
  prListArgs,
  prNodeIdArgs,
  replyThreadArgs,
  resolveThreadArgs,
  snapshotArgs,
  submitReviewArgs,
} from "./queries.ts";

export interface GitHubForgeOptions {
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

export function createGitHubForge(cwd: string, opts: GitHubForgeOptions = {}): Forge {
  const run = opts.run ?? defaultRunner(cwd);

  async function getPullRequest(prNumber: number): Promise<PullRequest> {
    const res = JSON.parse(await run(snapshotArgs(prNumber))) as GhGraphQlResponse<SnapshotData>;
    return mapPullRequest(res.data.repository.pullRequest);
  }

  // The thread/review mutations key off the PR's GraphQL node id, not its number.
  async function prNodeId(prNumber: number): Promise<string> {
    const res = JSON.parse(await run(prNodeIdArgs(prNumber))) as GhGraphQlResponse<PrIdData>;
    return res.data.repository.pullRequest.id;
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

    async updatePullRequestBody(input: { prNumber: number; body: string }): Promise<void> {
      await run(prEditBodyArgs(input.prNumber, input.body));
    },

    async createReviewThread(input: {
      prNumber: number;
      path: string;
      line: number;
      body: string;
      commitSha: string;
    }): Promise<ReviewThread> {
      // A published REST review comment (not a pending-review GraphQL thread) — anchored to the
      // reviewed head and immediately visible/resolvable, so it never collides with submitReview.
      const out = await run(createReviewCommentArgs(input));
      return mapRestReviewComment(JSON.parse(out) as GhRestReviewComment);
    },

    async replyToThread(input: { threadId: string; body: string }): Promise<void> {
      await run(replyThreadArgs(input));
    },

    async resolveThread(threadId: string): Promise<void> {
      await run(resolveThreadArgs(threadId));
    },

    async submitReview(input: {
      prNumber: number;
      commitSha: string;
      body: string;
    }): Promise<void> {
      const prId = await prNodeId(input.prNumber);
      await run(submitReviewArgs({ prId, commit: input.commitSha, body: input.body }));
    },

    async lastReviewedSha(prNumber: number): Promise<string | null> {
      const res = JSON.parse(
        await run(lastReviewArgs(prNumber)),
      ) as GhGraphQlResponse<LastReviewData>;
      return mapLastReviewedSha(res.data.repository.pullRequest.reviews.nodes);
    },
  };
}
