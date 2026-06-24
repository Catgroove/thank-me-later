import { describe, expect, test } from "bun:test";
import type { PullRequest } from "@tml/core";
import { branchNameFor, branchStep } from "../src/steps/branch.ts";
import { FakeGitProvider, FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

/** A minimal PR snapshot in the given state, for driving `findPullRequest`. */
function prInState(state: PullRequest["state"]): PullRequest {
  return {
    number: 7,
    url: "https://git-provider.test/pr/7",
    head: "feat/old",
    base: "main",
    title: "old work",
    body: "",
    state,
    mergeable: "mergeable",
    mergeStateStatus: "clean",
    checks: [],
  };
}

describe("branch step", () => {
  test("branchNameFor derives tml/ship-<sha>", () => {
    expect(branchNameFor("abc1234")).toBe("tml/ship-abc1234");
  });

  test("ships on the current branch when already on a feature branch (any mode)", async () => {
    const git = new FakeGit();
    git.currentBranchName = "feat/login-fix";
    git.defaultBranchName = "main";
    const { ctx, logs } = fakeCtx({ git });

    const result = await branchStep("require").run(ctx);

    expect(result).toEqual({ branchName: "feat/login-fix" });
    expect(git.calls).toEqual([]); // already on it — nothing created
    expect(logs).toContain("shipping on feat/login-fix");
  });

  test("ships under the current branch when its PR is still open (iterate)", async () => {
    const git = new FakeGit();
    git.currentBranchName = "feat/old";
    git.defaultBranchName = "main";
    const gitProvider = new FakeGitProvider();
    gitProvider.existing = prInState("open");
    const { ctx } = fakeCtx({ git, gitProvider });

    const result = await branchStep("ai").run(ctx);

    expect(result).toEqual({ branchName: "feat/old" });
    expect(git.calls).toEqual([]); // open PR — keep shipping under it
  });

  test.each(["merged", "closed"] as const)(
    "cuts a fresh branch off primary (ai mode) when the current branch's PR is %s",
    async (state) => {
      const git = new FakeGit();
      git.currentBranchName = "feat/old";
      git.defaultBranchName = "main";
      const gitProvider = new FakeGitProvider();
      gitProvider.existing = prInState(state);
      const agent = new FakeHarness();
      agent.result = { ok: true, summary: "named it", output: { branch: "feat/ai-named" } };
      const { ctx } = fakeCtx({ git, gitProvider, agent });

      const result = await branchStep("ai").run(ctx);

      expect(result).toEqual({ branchName: "feat/ai-named" });
      expect(git.calls).toEqual(["fetch main", "createBranch feat/ai-named from origin/main"]);
    },
  );

  test("cuts a fresh auto-named branch off primary when the current auto branch's PR is merged", async () => {
    const git = new FakeGit();
    git.currentBranchName = "tml/ship-deadbee";
    git.defaultBranchName = "main";
    git.headShaValue = "deadbee";
    git.headShaByRef.set("origin/main", "basebee");
    const gitProvider = new FakeGitProvider();
    gitProvider.existing = prInState("merged");
    const { ctx } = fakeCtx({ git, gitProvider });

    const result = await branchStep("auto").run(ctx);

    expect(result).toEqual({ branchName: "tml/ship-basebee" });
    expect(git.calls).toEqual(["fetch main", "createBranch tml/ship-basebee from origin/main"]);
  });

  test("require mode refuses when the current branch's PR is spent", async () => {
    const git = new FakeGit();
    git.currentBranchName = "feat/old";
    git.defaultBranchName = "main";
    const gitProvider = new FakeGitProvider();
    gitProvider.existing = prInState("merged");
    const { ctx } = fakeCtx({ git, gitProvider });

    const error = await branchStep("require")
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("spent");
    expect((error as Error).message).toContain("feat/old");
  });

  test("auto mode synthesizes tml/ship-<sha> and checks it out when on the default branch", async () => {
    const git = new FakeGit();
    git.currentBranchName = "main";
    git.defaultBranchName = "main";
    git.headShaValue = "deadbee";
    const { ctx } = fakeCtx({ git });

    const result = await branchStep("auto").run(ctx);

    expect(result).toEqual({ branchName: "tml/ship-deadbee" });
    expect(git.calls).toEqual(["createBranch tml/ship-deadbee"]);
  });

  test("ai mode asks the agent to name the branch when on the default branch", async () => {
    const git = new FakeGit();
    git.currentBranchName = "main";
    git.defaultBranchName = "main";
    const agent = new FakeHarness();
    agent.result = { ok: true, summary: "named it", output: { branch: "feat/ai-named" } };
    const { ctx } = fakeCtx({ git, agent });

    const result = await branchStep("ai").run(ctx);

    expect(result).toEqual({ branchName: "feat/ai-named" });
    expect(git.calls).toEqual(["createBranch feat/ai-named"]);
    expect(agent.tasks).toHaveLength(1);
  });

  test("ai mode throws if the agent doesn't return a { branch } name", async () => {
    const git = new FakeGit();
    git.currentBranchName = "main";
    git.defaultBranchName = "main";
    const agent = new FakeHarness();
    agent.result = { ok: true, summary: "oops", output: { branch: 123 } };
    const { ctx } = fakeCtx({ git, agent });

    const error = await branchStep("ai")
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("{ branch }");
  });

  test("require mode refuses when not on a feature branch", async () => {
    const git = new FakeGit();
    git.currentBranchName = "main";
    git.defaultBranchName = "main";
    const { ctx } = fakeCtx({ git });

    const error = await branchStep("require")
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("not on a feature branch");
  });

  test("unsupported modes fail clearly at runtime", async () => {
    const git = new FakeGit();
    git.currentBranchName = "main";
    git.defaultBranchName = "main";
    const { ctx } = fakeCtx({ git });

    const error = await branchStep("manual" as never)
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("unsupported branch mode");
  });
});
