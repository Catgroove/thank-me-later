import { describe, expect, test } from "bun:test";

import {
  CHECKS_QUERY,
  CHECK_LOG_LINKS_QUERY,
  checksArgs,
  checkLogLinksArgs,
  prCreateArgs,
  prEditBodyArgs,
  prListArgs,
  runViewFailedLogArgs,
  snapshotArgs,
  SNAPSHOT_QUERY,
} from "../src/queries.ts";

describe("argv builders", () => {
  test("prListArgs requests number and state across all states", () => {
    expect(prListArgs("feat/x")).toEqual([
      "pr",
      "list",
      "--head",
      "feat/x",
      "--state",
      "all",
      "--json",
      "number,state",
    ]);
  });

  test("prCreateArgs maps the open input to flags", () => {
    expect(prCreateArgs({ head: "feat/x", base: "main", title: "t", body: "b" })).toEqual([
      "pr",
      "create",
      "--head",
      "feat/x",
      "--base",
      "main",
      "--title",
      "t",
      "--body",
      "b",
    ]);
  });

  test("prEditBodyArgs maps PR body updates to gh flags", () => {
    expect(prEditBodyArgs({ prNumber: 42, body: "body" })).toEqual([
      "pr",
      "edit",
      "42",
      "--body",
      "body",
    ]);
  });

  test("snapshotArgs passes the query plus owner/repo placeholders and the number", () => {
    expect(snapshotArgs(42)).toEqual([
      "api",
      "graphql",
      "-f",
      `query=${SNAPSHOT_QUERY}`,
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      "number=42",
    ]);
  });

  test("checksArgs uses the lighter query for the given number", () => {
    expect(checksArgs(7)).toEqual([
      "api",
      "graphql",
      "-f",
      `query=${CHECKS_QUERY}`,
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      "number=7",
    ]);
  });

  test("checkLogLinksArgs requests check run links for failed-log lookup", () => {
    expect(checkLogLinksArgs(42)).toEqual([
      "api",
      "graphql",
      "-f",
      `query=${CHECK_LOG_LINKS_QUERY}`,
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      "number=42",
    ]);
  });

  test("runViewFailedLogArgs requests failed logs for an actions run", () => {
    expect(runViewFailedLogArgs("123")).toEqual(["run", "view", "123", "--log-failed"]);
  });
});

describe("queries", () => {
  test("check queries select the status-check rollup", () => {
    expect(SNAPSHOT_QUERY).toContain("statusCheckRollup");
    expect(CHECKS_QUERY).toContain("statusCheckRollup");
    expect(CHECK_LOG_LINKS_QUERY).toContain("statusCheckRollup");
    expect(CHECK_LOG_LINKS_QUERY).toContain("detailsUrl");
  });

  test("base queries do not select review-thread conversation state", () => {
    expect(SNAPSHOT_QUERY).not.toContain("reviewThreads");
    expect(CHECKS_QUERY).not.toContain("reviewThreads");
    expect(CHECK_LOG_LINKS_QUERY).not.toContain("reviewThreads");
  });
});
