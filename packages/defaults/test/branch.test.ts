import { describe, expect, test } from "bun:test";
import { branchNameFor, branchStep } from "../src/steps/branch.ts";
import { FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

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
