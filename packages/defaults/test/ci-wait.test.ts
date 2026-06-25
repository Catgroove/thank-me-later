import { describe, expect, test } from "bun:test";
import { TimeoutError, type CheckRun, type Pending, type PullRequest } from "@tml/core";
import { ciWaitStep } from "../src/steps/ci-wait.ts";
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

class SequencedGitProvider extends FakeGitProvider {
  readonly logRequests: { prNumber: number; checkNames?: string[] }[] = [];
  failedLogs = "failed log";
  private index = 0;

  constructor(private readonly sequence: readonly CheckRun[][]) {
    super();
  }

  override getChecks(_prNumber: number): Pending<CheckRun[]> {
    return {
      poll: () => {
        const next = this.sequence[this.index] ?? [];
        if (this.index < this.sequence.length - 1) {
          this.index += 1;
        }
        return Promise.resolve({ done: true as const, value: next });
      },
    };
  }

  getFailedCheckLogs(input: { prNumber: number; checkNames?: string[] }): Promise<string> {
    this.logRequests.push(input);
    return Promise.resolve(this.failedLogs);
  }
}

describe("ci-wait step", () => {
  test("polls checks to completion and logs each conclusion", async () => {
    const gitProvider = new FakeGitProvider();
    gitProvider.checks = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "success" },
    ];
    const { ctx, logs } = fakeCtx({ gitProvider, reads: { pullRequest: pr } });

    const result = await ciWaitStep().run(ctx);

    expect(result).toEqual({
      artifacts: {},
      rounds: [
        {
          trigger: "initial",
          findings: [],
          testing: {
            summary: "2 green, 0 failed, 0 pending CI checks.",
            tested: true,
            artifacts: ["build: success", "lint: success"],
          },
        },
      ],
    });
    expect(logs).toEqual(["ci: build -> success", "ci: lint -> success"]);
  });

  test("fixes failed checks, pushes the fix commit, and verifies CI again", async () => {
    const gitProvider = new SequencedGitProvider([
      [{ name: "build", status: "completed", conclusion: "failure" }],
      [{ name: "build", status: "completed", conclusion: "success" }],
    ]);
    const agent = new FakeHarness();
    agent.responses.push({ ok: true, summary: "fixed build" });
    const git = new FakeGit();
    git.stagedFiles = ["src/fix.ts"];
    git.commitSha = "abc";
    const { ctx, logs } = fakeCtx({ agent, git, gitProvider, reads: { pullRequest: pr } });

    const result = await ciWaitStep().run(ctx);
    const stepResult = result as { rounds?: { trigger?: string; findings?: unknown[] }[] };

    expect(agent.tasks).toHaveLength(1);
    expect(agent.tasks[0]).toContain("The pull request CI checks below failed");
    expect(agent.tasks[0]).toContain("failed log");
    expect(gitProvider.logRequests).toEqual([{ prNumber: 3, checkNames: ["build"] }]);
    expect(git.calls).toContain("commit chore(ci): fixed build");
    expect(git.calls).toContain("push tml/ship-abc1234");
    expect(logs).toContain("ci: build -> failure");
    expect(logs).toContain("ci: build -> success");
    expect(stepResult.rounds?.map((round) => round.trigger)).toEqual([
      "initial",
      "auto_fix",
      "verify",
    ]);
    expect(stepResult.rounds?.[0]?.findings).toMatchObject([
      { disposition: "blocker", action: "auto-fix", title: "build did not pass" },
    ]);
    expect(stepResult.rounds?.[2]?.findings).toEqual([]);
  });

  test("waits for the initial rollup to populate instead of passing on an empty one", async () => {
    // Right after a PR opens, GitHub reports an empty rollup before the workflow's checks
    // register. The gate must keep polling, not treat that empty set as "all green".
    const gitProvider = new SequencedGitProvider([
      [],
      [{ name: "build", status: "completed", conclusion: "success" }],
    ]);
    const { ctx, logs } = fakeCtx({ gitProvider, reads: { pullRequest: pr } });

    const result = await ciWaitStep().run(ctx);

    expect(logs).toContain("ci: build -> success");
    expect(result).toMatchObject({ rounds: [{ trigger: "initial", findings: [] }] });
  });

  test("waits for post-fix checks instead of accepting an empty rollup", async () => {
    const gitProvider = new SequencedGitProvider([
      [{ name: "build", status: "completed", conclusion: "failure" }],
      [],
      [{ name: "build", status: "completed", conclusion: "success" }],
    ]);
    const agent = new FakeHarness();
    agent.responses.push({ ok: true, summary: "fixed build" });
    const git = new FakeGit();
    git.stagedFiles = ["src/fix.ts"];
    const { ctx, logs } = fakeCtx({ agent, git, gitProvider, reads: { pullRequest: pr } });

    const result = await ciWaitStep().run(ctx);

    expect(logs).toContain("ci: build -> success");
    expect(result).toMatchObject({
      rounds: [
        { trigger: "initial", findings: [{ title: "build did not pass" }] },
        { trigger: "auto_fix" },
        { trigger: "verify", findings: [] },
      ],
    });
  });

  test("continues fixing when failed check logs cannot be retrieved", async () => {
    class LogFailGitProvider extends SequencedGitProvider {
      override getFailedCheckLogs(input: {
        prNumber: number;
        checkNames?: string[];
      }): Promise<string> {
        this.logRequests.push(input);
        return Promise.reject(new Error("logs expired"));
      }
    }
    const gitProvider = new LogFailGitProvider([
      [{ name: "build", status: "completed", conclusion: "failure" }],
      [{ name: "build", status: "completed", conclusion: "success" }],
    ]);
    const agent = new FakeHarness();
    agent.responses.push({ ok: true, summary: "fixed build" });
    const git = new FakeGit();
    git.stagedFiles = ["src/fix.ts"];
    const { ctx, logs } = fakeCtx({ agent, git, gitProvider, reads: { pullRequest: pr } });

    const result = await ciWaitStep().run(ctx);

    expect(agent.tasks).toHaveLength(1);
    expect(agent.tasks[0]).toContain("No failed check logs were available");
    expect(logs).toContain("ci-wait: failed to retrieve failed check logs: logs expired");
    expect(result).toMatchObject({ rounds: [{}, {}, { trigger: "verify", findings: [] }] });
  });

  test("reports cancelled checks as needing a user decision instead of auto-fixing", async () => {
    const gitProvider = new FakeGitProvider();
    gitProvider.checks = [{ name: "build", status: "completed", conclusion: "cancelled" }];
    const agent = new FakeHarness();
    const { ctx, approvals } = fakeCtx({ agent, gitProvider, reads: { pullRequest: pr } });

    const result = await ciWaitStep().run(ctx);

    expect(agent.tasks).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.findings).toMatchObject([
      { disposition: "blocker", action: "ask-user", title: "build did not pass" },
    ]);
    expect(result).toMatchObject({
      artifacts: {},
      rounds: [
        {
          trigger: "initial",
          findings: [{ disposition: "blocker", action: "ask-user", title: "build did not pass" }],
        },
        { trigger: "approval", resolution: "approved" },
      ],
    });
  });

  test("reports timed out checks through structured approval", async () => {
    class TimeoutGitProvider extends FakeGitProvider {
      override getChecks(_prNumber: number): Pending<CheckRun[]> {
        return { poll: () => Promise.reject(new TimeoutError()) };
      }
    }
    const gitProvider = new TimeoutGitProvider();
    const { ctx, approvals } = fakeCtx({ gitProvider, reads: { pullRequest: pr } });

    const result = await ciWaitStep().run(ctx);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.findings).toMatchObject([
      {
        disposition: "should-fix",
        action: "ask-user",
        title: "CI did not settle before the timeout",
      },
    ]);
    expect(result).toMatchObject({
      rounds: [
        { trigger: "initial", findings: [{ title: "CI did not settle before the timeout" }] },
        { trigger: "approval", resolution: "approved" },
      ],
    });
  });
});
