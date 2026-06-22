import { describe, expect, test } from "bun:test";

import {
  CHECKS_QUERY,
  checksArgs,
  prCreateArgs,
  prEditBodyArgs,
  prListArgs,
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
});

describe("queries", () => {
  test("both queries select the status-check rollup", () => {
    expect(SNAPSHOT_QUERY).toContain("statusCheckRollup");
    expect(CHECKS_QUERY).toContain("statusCheckRollup");
  });

  test("base queries do not select review-thread conversation state", () => {
    expect(SNAPSHOT_QUERY).not.toContain("reviewThreads");
    expect(CHECKS_QUERY).not.toContain("reviewThreads");
  });
});
