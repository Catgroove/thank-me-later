import { describe, expect, test } from "bun:test";

import {
  CHECKS_QUERY,
  checksArgs,
  prCreateArgs,
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

  test("only the snapshot query selects review threads (the checks poll stays light)", () => {
    expect(SNAPSHOT_QUERY).toContain("reviewThreads");
    expect(CHECKS_QUERY).not.toContain("reviewThreads");
  });
});
