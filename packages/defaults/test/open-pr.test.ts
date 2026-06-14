import { describe, expect, test } from "bun:test";
import type { PullRequest } from "@tml/core";
import { openPrStep } from "../src/steps/open-pr.ts";
import { FakeForge, FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

const reads = { branchName: "tml/ship-abc1234", reviewSummary: "fixed an off-by-one" };

function withDescription(): FakeHarness {
  const agent = new FakeHarness();
  agent.result = {
    ok: true,
    summary: "wrote pr",
    output: { title: "fix: off-by-one in pager", body: "Fixes the boundary case." },
  };
  return agent;
}

describe("open-pr step", () => {
  test("writes a description, then commits → pushes → opens (in that order)", async () => {
    const git = new FakeGit();
    const forge = new FakeForge();
    const { ctx } = fakeCtx({ git, forge, agent: withDescription(), reads });

    const result = (await openPrStep().run(ctx)) as { pullRequest: PullRequest };

    expect(git.calls).toEqual(["stageAll", "commit fix: off-by-one in pager", "push -u"]);
    expect(forge.opened).toHaveLength(1);
    expect(forge.opened[0]).toEqual({
      head: "tml/ship-abc1234",
      base: "main",
      title: "fix: off-by-one in pager",
      body: "Fixes the boundary case.",
    });
    expect(result.pullRequest.number).toBe(1);
    expect(result.pullRequest.body).toContain("boundary case");
  });

  test("is idempotent: an existing PR short-circuits commit/push/open", async () => {
    const git = new FakeGit();
    const forge = new FakeForge();
    const prior: PullRequest = {
      number: 7,
      url: "https://forge.test/pr/7",
      head: "tml/ship-abc1234",
      base: "main",
      title: "prior",
      body: "prior body",
      state: "open",
      mergeable: "mergeable",
      checks: [],
      threads: [],
    };
    forge.existing = prior;
    const { ctx } = fakeCtx({ git, forge, agent: withDescription(), reads });

    const result = (await openPrStep().run(ctx)) as { pullRequest: PullRequest };

    expect(result.pullRequest).toEqual(prior);
    expect(git.calls).toEqual([]); // nothing committed or pushed
    expect(forge.opened).toEqual([]); // nothing opened
  });

  test("throws if the agent output is not a { title, body }", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: true, summary: "oops", output: { title: 123 } };
    const { ctx } = fakeCtx({ agent, reads });

    let error: unknown;
    await openPrStep()
      .run(ctx)
      .catch((e: unknown) => {
        error = e;
      });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("title, body");
  });
});
