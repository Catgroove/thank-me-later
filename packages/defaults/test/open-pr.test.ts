import { describe, expect, test } from "bun:test";
import { makeFinding, type PullRequest, type RoundRecord } from "@tml/core";
import { openPrStep } from "../src/steps/open-pr.ts";
import { FakeGitProvider, FakeGit, fakeCtx } from "./fake-ctx.ts";

const reads = {
  branchName: "tml/ship-abc1234",
  prTitle: "fix: off-by-one in pager",
  prBody: "Fixes the boundary case.",
  reviewSummary: "fixed an off-by-one",
};

const finding = makeFinding("review", {
  disposition: "should-fix",
  action: "ask-user",
  title: "Confirm behavior",
  detail: "Public behavior changed.",
});

const rounds: RoundRecord[] = [
  { step: "quality", index: 0, trigger: "initial", findings: [] },
  { step: "review", index: 0, trigger: "initial", findings: [finding] },
];

const syncedPushCalls = [
  "fetch main",
  "isAncestor origin/main HEAD",
  "isAncestor HEAD origin/main",
  "push (force) tml/ship-abc1234",
];

function freshGit(): FakeGit {
  const git = new FakeGit();
  git.ancestry.set("origin/main..HEAD", true);
  return git;
}

describe("open-pr step", () => {
  test("pushes the branch and opens the PR with a generated audit block", async () => {
    const git = freshGit();
    const gitProvider = new FakeGitProvider();
    const { ctx } = fakeCtx({ git, gitProvider, reads, rounds });

    const result = (await openPrStep().run(ctx)) as { pullRequest: PullRequest };

    // No commit: the work and fixes were committed by earlier Steps.
    expect(git.calls).toEqual(syncedPushCalls);
    expect(gitProvider.opened).toHaveLength(1);
    expect(gitProvider.opened[0]?.head).toBe("tml/ship-abc1234");
    expect(gitProvider.opened[0]?.base).toBe("main");
    expect(gitProvider.opened[0]?.title).toBe("fix: off-by-one in pager");
    expect(gitProvider.opened[0]?.body).toContain("<!-- tml:summary:start -->");
    expect(gitProvider.opened[0]?.body).toContain("## Pipeline");
    expect(gitProvider.opened[0]?.body).toContain("| review | unresolved | 1 | 0 | initial | 1 |");
    expect(gitProvider.opened[0]?.body).toContain("fixed an off-by-one");
    expect(result.pullRequest.number).toBe(1);
  });

  test("records empty review and round summaries explicitly", async () => {
    const git = freshGit();
    const gitProvider = new FakeGitProvider();
    const { ctx } = fakeCtx({ git, gitProvider, reads: { ...reads, reviewSummary: "" } });

    await openPrStep().run(ctx);

    expect(gitProvider.opened[0]?.body).toContain("No local rounds recorded.");
    expect(gitProvider.opened[0]?.body).toContain("No unresolved findings.");
  });

  test("is idempotent: an existing PR is reused after pushing local commits", async () => {
    const git = freshGit();
    const gitProvider = new FakeGitProvider();
    const prior: PullRequest = {
      number: 7,
      url: "https://git-provider.test/pr/7",
      head: "tml/ship-abc1234",
      base: "main",
      title: "prior",
      body: "prior body",
      state: "open",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      checks: [],
    };
    gitProvider.existing = prior;
    const { ctx } = fakeCtx({ git, gitProvider, reads });

    const result = (await openPrStep().run(ctx)) as { pullRequest: PullRequest };

    expect(result.pullRequest.body).toContain("<!-- tml:summary:start -->");
    expect(git.calls).toEqual(syncedPushCalls); // update the existing PR's branch
    expect(gitProvider.opened).toEqual([]); // nothing opened
    expect(gitProvider.bodyUpdates).toHaveLength(1);
  });

  test.each(["merged", "closed"] as const)(
    "opens a fresh PR when the head's only PR is %s (not reused)",
    async (state) => {
      const git = freshGit();
      const gitProvider = new FakeGitProvider();
      gitProvider.existing = {
        number: 7,
        url: "https://git-provider.test/pr/7",
        head: "tml/ship-abc1234",
        base: "main",
        title: "prior",
        body: "prior body",
        state,
        mergeable: "unknown",
        mergeStateStatus: "unknown",
        checks: [],
      };
      const { ctx } = fakeCtx({ git, gitProvider, reads });

      const result = (await openPrStep().run(ctx)) as { pullRequest: PullRequest };

      expect(gitProvider.opened).toHaveLength(1); // spent PR, so a new one is opened
      expect(result.pullRequest.number).toBe(1);
      expect(result.pullRequest.state).toBe("open");
    },
  );
});
