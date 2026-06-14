import { describe, expect, test } from "bun:test";
import { defineStep, type Step } from "@tml/core";
import { prTitle } from "../src/artifacts.ts";
import { commitGroup, commitStep } from "../src/steps/commit.ts";
import { FakeGit, fakeCtx } from "./fake-ctx.ts";

const noop = (name: string): Step => defineStep({ name, run: () => Promise.resolve({}) });

describe("commitStep", () => {
  test("stages and commits with a literal message when the tree is dirty", async () => {
    const git = new FakeGit();
    git.stagedFiles = ["a.ts"];
    const { ctx } = fakeCtx({ git });

    await commitStep("commit-fixes", "chore: apply fixes").run(ctx);

    expect(git.calls).toEqual(["stageAll", "commit chore: apply fixes"]);
  });

  test("reads its message from an artifact when given one", async () => {
    const git = new FakeGit();
    git.stagedFiles = ["a.ts"];
    const { ctx } = fakeCtx({ git, reads: { prTitle: "feat: the change" } });

    const step = commitStep("commit-change", prTitle);
    expect(step.consumes.map((a) => a.name)).toEqual(["prTitle"]);
    await step.run(ctx);

    expect(git.calls).toEqual(["stageAll", "commit feat: the change"]);
  });

  test("skips (no empty commit) when nothing was staged", async () => {
    const git = new FakeGit(); // stagedFiles defaults to []
    const { ctx, logs } = fakeCtx({ git });

    const result = await commitStep("commit-fixes", "chore: apply fixes").run(ctx);

    expect((result as { kind?: string }).kind).toBe("skip");
    expect(git.calls).toEqual(["stageAll"]); // staged, found nothing, did not commit
    expect(logs).toContain("nothing to commit");
  });
});

describe("commitGroup", () => {
  test("returns the wrapped Steps followed by a commit Step named + messaged after them", async () => {
    const steps = commitGroup(noop("format"), noop("lint"));

    expect(steps.map((s) => s.name)).toEqual(["format", "lint", "commit(format+lint)"]);

    const git = new FakeGit();
    git.stagedFiles = ["a.ts"];
    const { ctx } = fakeCtx({ git });
    await steps[2]?.run(ctx);

    expect(git.calls).toEqual(["stageAll", "commit chore: apply fixes from format, lint"]);
  });
});
