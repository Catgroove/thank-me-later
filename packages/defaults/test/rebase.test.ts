import { describe, expect, test } from "bun:test";
import { cancel, skip } from "@tml/core";
import { rebaseStep } from "../src/steps/rebase.ts";
import { FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

/** A FakeGit on `main` with the base diverged from HEAD (so a rebase is warranted by default). */
function divergedGit(): FakeGit {
  const git = new FakeGit();
  git.defaultBranchName = "main";
  git.currentBranchName = "feat/x";
  return git;
}

describe("rebase step", () => {
  test("skips when there is no remote to rebase onto", async () => {
    const git = divergedGit();
    git.fetchThrows = true;
    const { ctx, logs } = fakeCtx({ git });

    expect(await rebaseStep().run(ctx)).toEqual(skip());
    expect(git.calls).toEqual(["fetch main"]); // never reached the rebase
    expect(logs.some((l) => l.includes("no origin/main"))).toBe(true);
  });

  test("skips when the base is already an ancestor of HEAD (already fresh)", async () => {
    const git = divergedGit();
    git.ancestry.set("origin/main..HEAD", true);
    const { ctx, logs } = fakeCtx({ git });

    expect(await rebaseStep().run(ctx)).toEqual(skip());
    expect(git.calls).toEqual([
      "fetch main",
      "isAncestor origin/main HEAD",
      "isAncestor HEAD origin/main",
    ]);
    expect(logs.some((l) => l.includes("already up to date"))).toBe(true);
  });

  test("cancels instead of opening an empty PR when HEAD already equals the base", async () => {
    const git = divergedGit();
    git.ancestry.set("origin/main..HEAD", true);
    git.ancestry.set("HEAD..origin/main", true);
    const { ctx } = fakeCtx({ git });

    expect(await rebaseStep().run(ctx)).toEqual(
      cancel("nothing to ship: this work is already in main"),
    );
    expect(git.calls).toEqual([
      "fetch main",
      "isAncestor origin/main HEAD",
      "isAncestor HEAD origin/main",
    ]);
  });

  test("rebases cleanly and continues when commits remain", async () => {
    const git = divergedGit();
    git.rebaseResult = { status: "clean" };
    // base not ancestor of HEAD (rebase needed); HEAD not ancestor of base afterwards (commits remain)
    const { ctx } = fakeCtx({ git });

    expect(await rebaseStep().run(ctx)).toEqual({});
    expect(git.calls).toEqual([
      "fetch main",
      "isAncestor origin/main HEAD",
      "rebase origin/main",
      "isAncestor HEAD origin/main",
    ]);
  });

  test("cancels when the rebase drops every commit (work already upstream)", async () => {
    const git = divergedGit();
    git.rebaseResult = { status: "clean" };
    git.ancestry.set("HEAD..origin/main", true); // HEAD is now contained in base → empty
    const { ctx } = fakeCtx({ git });

    expect(await rebaseStep().run(ctx)).toEqual(
      cancel("nothing to ship: this work is already in main"),
    );
  });

  test("hands conflicts to the agent and continues when it resolves them", async () => {
    const git = divergedGit();
    git.rebaseResult = { status: "conflict", files: ["a.ts", "b.ts"] };
    git.rebaseInProgressValue = false; // agent finished the rebase
    const agent = new FakeHarness();
    agent.result = { ok: true, summary: "resolved" };
    const { ctx, logs } = fakeCtx({ git, agent });

    expect(await rebaseStep().run(ctx)).toEqual({});
    expect(agent.tasks).toHaveLength(1);
    expect(agent.tasks[0]).toContain("a.ts");
    expect(git.calls).not.toContain("rebaseAbort");
    expect(logs.some((l) => l.includes("agent resolved"))).toBe(true);
  });

  test("aborts and throws when the agent reports failure with the rebase still in progress", async () => {
    const git = divergedGit();
    git.rebaseResult = { status: "conflict", files: ["a.ts"] };
    git.rebaseInProgressValue = true;
    const agent = new FakeHarness();
    agent.result = { ok: false, summary: "too hard" };
    const { ctx } = fakeCtx({ git, agent });

    const error = await rebaseStep()
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("could not resolve");
    expect(git.calls).toContain("rebaseAbort");
  });

  test("does not mask the failure when the agent already ended the rebase", async () => {
    const git = divergedGit();
    git.rebaseResult = { status: "conflict", files: ["a.ts"] };
    git.rebaseInProgressValue = false;
    const agent = new FakeHarness();
    agent.result = { ok: false, summary: "aborted" };
    const { ctx } = fakeCtx({ git, agent });

    const error = await rebaseStep()
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("could not resolve");
    expect((error as Error).message).toContain("inspect the branch");
    expect(git.calls).not.toContain("rebaseAbort");
  });

  test("aborts and throws when the agent leaves the rebase in progress", async () => {
    const git = divergedGit();
    git.rebaseResult = { status: "conflict", files: ["a.ts"] };
    git.rebaseInProgressValue = true; // agent claimed ok but didn't finish
    const agent = new FakeHarness();
    agent.result = { ok: true, summary: "done (not really)" };
    const { ctx } = fakeCtx({ git, agent });

    const error = await rebaseStep()
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("could not resolve");
    expect(git.calls).toContain("rebaseAbort");
  });
});
