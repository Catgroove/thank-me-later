import { describe, expect, test } from "bun:test";
import { TimeoutError, type MergeState, type Pending, type PullRequest } from "@tml/core";
import { mergeGateStep } from "../src/steps/merge-gate.ts";
import { FakeGit, FakeGitProvider, FakeHarness, fakeCtx } from "./fake-ctx.ts";

const pr: PullRequest = {
  number: 3,
  url: "https://git-provider.test/pr/3",
  head: "tml/ship-abc1234",
  base: "main",
  title: "t",
  body: "b",
  state: "open",
  mergeable: "mergeable",
  mergeStateStatus: "clean",
  checks: [],
};

/** Walks a sequence of merge states across polls, repeating the last once exhausted. */
class SequencedMergeProvider extends FakeGitProvider {
  private index = 0;

  constructor(private readonly sequence: readonly MergeState[]) {
    super();
  }

  override getMergeState(_prNumber: number): Pending<MergeState> {
    return {
      poll: () => {
        const next = this.sequence[this.index] ?? "clean";
        if (this.index < this.sequence.length - 1) this.index += 1;
        return Promise.resolve({ done: true as const, value: next });
      },
    };
  }
}

describe("merge-gate step", () => {
  test("passes when the host reports the PR mergeable", async () => {
    const gitProvider = new FakeGitProvider();
    gitProvider.mergeStateStatus = "clean";
    const { ctx, logs } = fakeCtx({ gitProvider, reads: { pullRequest: pr } });

    const result = await mergeGateStep().run(ctx);

    expect(logs).toEqual(["merge: clean (mergeable)"]);
    expect(result).toEqual({ artifacts: {}, rounds: [{ trigger: "initial", findings: [] }] });
  });

  test("reports a blocked PR as needing a user decision", async () => {
    const gitProvider = new FakeGitProvider();
    gitProvider.mergeStateStatus = "blocked";
    const { ctx, approvals } = fakeCtx({ gitProvider, reads: { pullRequest: pr } });

    const result = await mergeGateStep().run(ctx);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.findings).toMatchObject([
      { disposition: "blocker", action: "ask-user", title: "PR is not mergeable (blocked)" },
    ]);
    expect(result).toMatchObject({
      rounds: [
        { trigger: "initial", findings: [{ title: "PR is not mergeable (blocked)" }] },
        { trigger: "user_fix", fixSummary: "Operator approved unresolved findings." },
      ],
    });
  });

  test("flags a draft PR as should-fix", async () => {
    const gitProvider = new FakeGitProvider();
    gitProvider.mergeStateStatus = "draft";
    const { ctx } = fakeCtx({ gitProvider, reads: { pullRequest: pr } });

    const result = await mergeGateStep().run(ctx);

    expect(result).toMatchObject({
      rounds: [
        {
          trigger: "initial",
          findings: [
            { disposition: "should-fix", action: "ask-user", title: "PR is not mergeable (draft)" },
          ],
        },
        {},
      ],
    });
  });

  test("fixes a behind branch, then verifies it is mergeable", async () => {
    const gitProvider = new SequencedMergeProvider(["behind", "clean"]);
    const agent = new FakeHarness();
    agent.responses.push({ ok: true, summary: "rebased onto main" });
    const git = new FakeGit();
    const { ctx } = fakeCtx({
      agent,
      git,
      gitProvider,
      reads: { pullRequest: pr },
      approveFindings: (input) =>
        Promise.resolve({ action: "fix", selectedFindingIds: input.findings.map((f) => f.id) }),
    });

    const result = await mergeGateStep().run(ctx);

    expect(agent.tasks).toHaveLength(1);
    expect(agent.tasks[0]).toContain("not mergeable (merge state: behind)");
    // The fix owns its own git (rebase + force-push), so the gate makes no commit of its own.
    expect(git.calls).not.toContain("commit chore: make the PR mergeable");
    expect(result).toMatchObject({
      rounds: [
        { trigger: "initial", findings: [{ title: "PR is not mergeable (behind)" }] },
        { trigger: "user_fix" },
        { trigger: "verify", findings: [] },
      ],
    });
  });

  test("reports a stuck merge state through structured approval on timeout", async () => {
    class TimeoutMergeProvider extends FakeGitProvider {
      override getMergeState(_prNumber: number): Pending<MergeState> {
        return { poll: () => Promise.reject(new TimeoutError()) };
      }
    }
    const gitProvider = new TimeoutMergeProvider();
    const { ctx, approvals } = fakeCtx({ gitProvider, reads: { pullRequest: pr } });

    const result = await mergeGateStep().run(ctx);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.findings).toMatchObject([
      { action: "ask-user", title: "Merge readiness did not settle before the timeout" },
    ]);
    expect(result).toMatchObject({
      rounds: [
        {
          trigger: "initial",
          findings: [{ title: "Merge readiness did not settle before the timeout" }],
        },
        { trigger: "user_fix" },
      ],
    });
  });
});
