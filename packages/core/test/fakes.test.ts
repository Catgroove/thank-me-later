import { describe, expect, test } from "bun:test";
import { until } from "../src/pending.ts";
import { FakeForge, FakeHarness } from "./fakes.ts";

describe("FakeForge", () => {
  test("findPullRequest is null until one is opened, then returns it (idempotency hook)", async () => {
    const forge = new FakeForge();
    expect(await forge.findPullRequest("feature/x")).toBeNull();

    const pr = await forge.openPullRequest({
      head: "feature/x",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(pr.number).toBe(1);

    const found = await forge.findPullRequest("feature/x");
    expect(found?.number).toBe(1);
  });

  test("getChecks settles through until after the configured number of polls", async () => {
    const forge = new FakeForge({ checksSettleAfter: 3 });
    const checks = await until(forge.getChecks(), { every: 1 });
    expect(checks[0]?.conclusion).toBe("success");
  });
});

describe("FakeHarness", () => {
  test("run records the task and settles to a result via until", async () => {
    const agent = new FakeHarness();
    const result = await until(agent.run("format the repo"), { every: 1 });
    expect(result.ok).toBe(true);
    expect(agent.tasks).toEqual(["format the repo"]);
  });
});
