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
import {
  checksArgs,
  checkLogLinksArgs,
  prCreateArgs,
  prEditBodyArgs,
  prListArgs,
  runViewFailedLogArgs,
  snapshotArgs,
} from "./queries.ts";

export interface GitHubProviderOptions {
  /** Override the `gh` runner; tests inject a fake returning canned JSON. */
  readonly run?: GhRunner;
}

type GhCheckLogNode =
  | {
      readonly __typename: "CheckRun";
      readonly name: string;
      readonly status: string;
      readonly conclusion: string | null;
      readonly detailsUrl?: string;
    }
  | {
      readonly __typename: "StatusContext";
      readonly context: string;
      readonly state: string;
      readonly targetUrl?: string;
    };

interface CheckLogLinksData {
  readonly repository: {
    readonly pullRequest: { readonly commits: { readonly nodes: readonly GhCommitLinksNode[] } };
  };
}

interface GhCommitLinksNode {
  readonly commit: {
    readonly statusCheckRollup: {
      readonly contexts: { readonly nodes: readonly GhCheckLogNode[] };
    } | null;
  };
}

interface CheckLogRow {
  readonly name: string;
  readonly state?: string;
  readonly conclusion?: string | null;
  readonly link?: string;
}

/** Parse the PR number out of the URL `gh pr create` prints on stdout. */
function parsePrNumber(out: string): number {
  const match = out.trim().match(/\/pull\/(\d+)/);
  if (match === null) {
    throw new Error(`could not parse a PR number from gh output: ${out.trim()}`);
  }
  return Number(match[1]);
}

function parseActionsRunId(link: string | undefined): string | undefined {
  return link?.match(/\/actions\/runs\/(\d+)/)?.[1];
}

function isFailedRow(row: CheckLogRow): boolean {
  const conclusion = row.conclusion?.toLowerCase();
  const state = row.state?.toLowerCase();
  return conclusion === "failure" || state === "failure" || state === "error";
}

function checkLogRow(node: GhCheckLogNode): CheckLogRow {
  if (node.__typename === "CheckRun") {
    return {
      name: node.name,
      state: node.status,
      conclusion: node.conclusion,
      link: node.detailsUrl,
    };
  }
  return { name: node.context, state: node.state, link: node.targetUrl };
}

function checkLogRows(data: CheckLogLinksData): CheckLogRow[] {
  const rollup = data.repository.pullRequest.commits.nodes[0]?.commit.statusCheckRollup;
  return (rollup?.contexts.nodes ?? []).map(checkLogRow);
}

function renderCheckRows(rows: readonly CheckLogRow[]): string {
  if (rows.length === 0) return "No failed check rows were available from gh.";
  return rows
    .map(
      (row) =>
        `- ${row.name}: ${row.conclusion ?? row.state ?? "unknown"}${row.link ? ` (${row.link})` : ""}`,
    )
    .join("\n");
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

    async getFailedCheckLogs(input: { prNumber: number; checkNames?: string[] }): Promise<string> {
      const res = JSON.parse(
        await run(checkLogLinksArgs(input.prNumber)),
      ) as GhGraphQlResponse<CheckLogLinksData>;
      const rows = checkLogRows(res.data);
      const names = new Set(input.checkNames ?? []);
      const failed = rows.filter(
        (row) => (names.size === 0 || names.has(row.name)) && isFailedRow(row),
      );
      const runIds = [
        ...new Set(
          failed
            .map((row) => parseActionsRunId(row.link))
            .filter((id): id is string => id !== undefined),
        ),
      ];
      if (runIds.length === 0) return renderCheckRows(failed);

      const logs: string[] = [];
      for (const runId of runIds) {
        const log = (await run(runViewFailedLogArgs(runId))).trim();
        if (log.length > 0) logs.push(`## GitHub Actions run ${runId}\n\n${log}`);
      }
      return logs.length > 0 ? logs.join("\n\n") : renderCheckRows(failed);
    },
  };
}
