import { describe, expect, test } from "bun:test";

import {
  CHECKS_QUERY,
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
  SNAPSHOT_QUERY,
  submitReviewArgs,
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

describe("mutation + lookup argv builders", () => {
  test("prNodeIdArgs / lastReviewArgs pass the number through graphql", () => {
    expect(prNodeIdArgs(42)).toContain("number=42");
    expect(lastReviewArgs(7)).toContain("number=7");
  });

  test("createReviewCommentArgs builds a REST POST anchored to the commit, line as a numeric var", () => {
    const args = createReviewCommentArgs({
      prNumber: 42,
      path: "src/x.ts",
      line: 9,
      body: "detail",
      commitSha: "abc",
    });
    expect(args.slice(0, 4)).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/pulls/42/comments",
    ]);
    expect(args).toContain("commit_id=abc");
    expect(args).toContain("path=src/x.ts");
    expect(args).toContain("body=detail");
    expect(args).toContain("side=RIGHT");
    // line follows a -F flag (numeric), not -f.
    expect(args[args.indexOf("line=9") - 1]).toBe("-F");
  });

  test("replyThreadArgs / resolveThreadArgs carry the thread id", () => {
    expect(replyThreadArgs({ threadId: "RT_1", body: "hi" })).toEqual(
      expect.arrayContaining(["threadId=RT_1", "body=hi"]),
    );
    expect(resolveThreadArgs("RT_2")).toContain("threadId=RT_2");
  });

  test("submitReviewArgs carries the PR id and the commit", () => {
    const args = submitReviewArgs({ prId: "PR_1", commit: "abc", body: "ok" });
    expect(args).toEqual(expect.arrayContaining(["prId=PR_1", "commit=abc", "body=ok"]));
  });

  test("prEditBodyArgs builds a gh pr edit call", () => {
    expect(prEditBodyArgs(42, "new body")).toEqual(["pr", "edit", "42", "--body", "new body"]);
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

  test("the snapshot query selects the new thread/PR fields", () => {
    for (const field of [
      "reviewDecision",
      "headRefOid",
      "isOutdated",
      "line",
      "viewerDidAuthor",
      "reactionGroups",
    ]) {
      expect(SNAPSHOT_QUERY).toContain(field);
    }
  });
});
