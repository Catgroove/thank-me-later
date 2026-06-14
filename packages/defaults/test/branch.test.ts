import { describe, expect, test } from "bun:test";
import { branchNameFor, branchStep } from "../src/steps/branch.ts";
import { FakeGit, fakeCtx } from "./fake-ctx.ts";

describe("branch step", () => {
  test("branchNameFor derives tml/ship-<sha>", () => {
    expect(branchNameFor("abc1234")).toBe("tml/ship-abc1234");
  });

  test("creates the derived branch and produces branchName", async () => {
    const git = new FakeGit();
    git.headShaValue = "deadbee";
    const { ctx } = fakeCtx({ git });

    const result = await branchStep().run(ctx);

    expect(result).toEqual({ branchName: "tml/ship-deadbee" });
    expect(git.calls).toEqual(["createBranch tml/ship-deadbee"]);
  });
});
