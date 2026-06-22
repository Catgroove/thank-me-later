import { describe, expect, test } from "bun:test";
import { until } from "../src/pending.ts";
import { FakeGitProvider, FakeHarness } from "./fakes.ts";

describe("FakeGitProvider", () => {
  test("findPullRequest is null until one is opened, then returns it (idempotency hook)", async () => {
    const gitProvider = new FakeGitProvider();
    expect(await gitProvider.findPullRequest("feature/x")).toBeNull();

    const pr = await gitProvider.openPullRequest({
      head: "feature/x",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(pr.number).toBe(1);

    const found = await gitProvider.findPullRequest("feature/x");
    expect(found?.number).toBe(1);
  });

  test("getChecks settles through until after the configured number of polls", async () => {
    const gitProvider = new FakeGitProvider({ checksSettleAfter: 3 });
    const checks = await until(gitProvider.getChecks(), { every: 1 });
    expect(checks[0]?.conclusion).toBe("success");
  });
});

describe("FakeHarness", () => {
  test("run records the task and resolves to a result (a Promise, not a Pending)", async () => {
    const agent = new FakeHarness();
    const result = await agent.run("format the repo");
    expect(result.ok).toBe(true);
    expect(agent.tasks).toEqual(["format the repo"]);
  });
});
