import { describe, expect, test } from "bun:test";

import {
  checksArgs,
  prCreateArgs,
  prEditBodyArgs,
  prListArgs,
  prViewArgs,
  runViewFailedLogArgs,
} from "../src/args.ts";

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

  test("prViewArgs requests the full PR snapshot with status checks", () => {
    expect(prViewArgs(42)).toEqual([
      "pr",
      "view",
      "42",
      "--json",
      "number,url,headRefName,baseRefName,title,body,state,mergeable,statusCheckRollup",
    ]);
  });

  test("checksArgs requests only the status-check rollup", () => {
    expect(checksArgs(7)).toEqual(["pr", "view", "7", "--json", "statusCheckRollup"]);
  });

  test("runViewFailedLogArgs requests failed logs for an actions run", () => {
    expect(runViewFailedLogArgs("123")).toEqual(["run", "view", "123", "--log-failed"]);
  });
});
