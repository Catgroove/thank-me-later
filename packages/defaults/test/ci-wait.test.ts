import { describe, expect, test } from "bun:test";
import type { PullRequest } from "@tml/core";
import { ciWaitStep } from "../src/steps/ci-wait.ts";
import { FakeForge, fakeCtx } from "./fake-ctx.ts";

const pr: PullRequest = {
  number: 3,
  url: "https://forge.test/pr/3",
  head: "tml/ship-abc1234",
  base: "main",
  title: "t",
  body: "b",
  state: "open",
  mergeable: "mergeable",
  checks: [],
  threads: [],
};

describe("ci-wait step", () => {
  test("polls checks to completion and logs each conclusion", async () => {
    const forge = new FakeForge();
    forge.checks = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "success" },
    ];
    const { ctx, logs } = fakeCtx({ forge, reads: { pullRequest: pr } });

    const result = await ciWaitStep().run(ctx);

    expect(result).toEqual({});
    expect(logs).toEqual(["ci: build → success", "ci: lint → success"]);
  });

  test("report-only: a failing check is logged, not a Run failure", async () => {
    const forge = new FakeForge();
    forge.checks = [{ name: "build", status: "completed", conclusion: "failure" }];
    const { ctx, logs } = fakeCtx({ forge, reads: { pullRequest: pr } });

    // Resolves normally (no throw / cancel) even though CI is red.
    const result = await ciWaitStep().run(ctx);
    expect(result).toEqual({});
    expect(logs).toEqual(["ci: build → failure"]);
  });
});
