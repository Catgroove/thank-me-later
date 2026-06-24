// `gh` argv builders. Pure: each builder returns the argv array passed to a
// `GhRunner`. Prefer high-level `gh pr` JSON commands over hand-written GraphQL;
// `gh` owns auth, repo detection, and JSON shape normalization.

import type { OpenPullRequestInput } from "@tml/core";

const PR_VIEW_FIELDS = [
  "number",
  "url",
  "headRefName",
  "baseRefName",
  "title",
  "body",
  "state",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
].join(",");

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

/** Full base snapshot: PR fields + mergeable + checks. */
export function prViewArgs(prNumber: number): string[] {
  return ["pr", "view", String(prNumber), "--json", PR_VIEW_FIELDS];
}

/** Cheap check polling: the status-check rollup only. */
export function checksArgs(prNumber: number): string[] {
  return ["pr", "view", String(prNumber), "--json", "statusCheckRollup"];
}

export function runViewFailedLogArgs(runId: string): string[] {
  return ["run", "view", runId, "--log-failed"];
}

/**
 * The active rules applying to a branch, each tagged with its `ruleset_id`. `gh` resolves the
 * `{owner}`/`{repo}` placeholders from the repo, and GitHub does the ref-matching for us.
 */
export function branchRulesArgs(branch: string): string[] {
  return ["api", `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(branch)}`];
}

/** A single ruleset, including `current_user_can_bypass` (which the rulesets-list endpoint omits). */
export function rulesetArgs(rulesetId: number): string[] {
  return ["api", `repos/{owner}/{repo}/rulesets/${rulesetId}`];
}
