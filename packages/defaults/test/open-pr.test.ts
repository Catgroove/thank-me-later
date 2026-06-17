import { describe, expect, test } from "bun:test";
import type { PullRequest } from "@tml/core";
import { openPrStep } from "../src/steps/open-pr.ts";
import { FakeForge, FakeGit, fakeCtx } from "./fake-ctx.ts";

const reads = {
  branchName: "tml/ship-abc1234",
  prTitle: "fix: off-by-one in pager",
  prBody: "Fixes the boundary case.",
  reviewSummary: "fixed an off-by-one",
};

describe("open-pr step", () => {
  test("pushes the branch and opens the PR, folding the review into the body", async () => {
    const git = new FakeGit();
    const forge = new FakeForge();
    const { ctx } = fakeCtx({ git, forge, reads });

    const result = (await openPrStep().run(ctx)) as { pullRequest: PullRequest };

    // No commit — the work and fixes were committed by the commit Steps already.
    expect(git.calls).toEqual(["push (force) tml/ship-abc1234"]);
    expect(forge.opened).toHaveLength(1);
    expect(forge.opened[0]).toEqual({
      head: "tml/ship-abc1234",
      base: "main",
      title: "fix: off-by-one in pager",
      body: "Fixes the boundary case.\n\n## Review\n\nfixed an off-by-one",
    });
    expect(result.pullRequest.number).toBe(1);
  });

  test("omits the review section when the summary is empty", async () => {
    const git = new FakeGit();
    const forge = new FakeForge();
    const { ctx } = fakeCtx({ git, forge, reads: { ...reads, reviewSummary: "" } });

    await openPrStep().run(ctx);

    expect(forge.opened[0]?.body).toBe("Fixes the boundary case.");
  });

  test("is idempotent: an existing PR is reused after pushing local commits", async () => {
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
    const { ctx } = fakeCtx({ git, forge, reads });

    const result = (await openPrStep().run(ctx)) as { pullRequest: PullRequest };

    expect(result.pullRequest).toEqual(prior);
    expect(git.calls).toEqual(["push (force) tml/ship-abc1234"]); // update the existing PR's branch
    expect(forge.opened).toEqual([]); // nothing opened
  });

  test.each(["merged", "closed"] as const)(
    "opens a fresh PR when the head's only PR is %s (not reused)",
    async (state) => {
      const git = new FakeGit();
      const forge = new FakeForge();
      forge.existing = {
        number: 7,
        url: "https://forge.test/pr/7",
        head: "tml/ship-abc1234",
        base: "main",
        title: "prior",
        body: "prior body",
        state,
        mergeable: "unknown",
        checks: [],
        threads: [],
      };
      const { ctx } = fakeCtx({ git, forge, reads });

      const result = (await openPrStep().run(ctx)) as { pullRequest: PullRequest };

      expect(forge.opened).toHaveLength(1); // spent PR — a new one is opened
      expect(result.pullRequest.number).toBe(1);
      expect(result.pullRequest.state).toBe("open");
    },
  );
});
