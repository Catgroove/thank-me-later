import { describe, expect, test } from "bun:test";
import { makeFinding, type AgentResult, type AgentRunOpts } from "@tml/core";
import { reviewStep } from "../src/steps/review.ts";
import { architectureSchema, findingsSchema } from "../src/prompts.ts";
import { FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

/** A scripted review-pass reply: structured `output` against the findings schema. */
function pass(findings: unknown[], extra: Record<string, unknown> = {}): AgentResult {
  return { ok: true, summary: "pass done", output: { findings, ...extra } };
}

function summaryOf(result: unknown): string {
  const output = result as { artifacts?: { reviewSummary?: unknown }; reviewSummary?: unknown };
  const value = output.artifacts?.reviewSummary ?? output.reviewSummary;
  return typeof value === "string" ? value : "";
}

describe("review step", () => {
  test("runs four read-only passes in order, the architecture pass requiring a verdict", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([], { understanding: "adds a --json flag" }),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
    );
    const git = new FakeGit();
    const { ctx, asks, recordedRounds } = fakeCtx({
      agent,
      git,
      reads: { prBody: "Adds --json output" },
    });

    const result = await reviewStep().run(ctx);

    expect(agent.tasks).toHaveLength(4); // no fix pass - no auto-fix findings
    expect(git.calls.filter((call) => call === "diffAgainst main")).toHaveLength(1);
    expect(agent.tasks.every((task) => task.includes("Injected branch diff"))).toBe(true);
    expect(agent.opts[1]?.schema).toBe(architectureSchema); // architecture: verdict required
    for (const i of [0, 2, 3]) expect(agent.opts[i]?.schema).toBe(findingsSchema);
    expect(asks).toHaveLength(0); // the gate never calls ctx.ask
    const stepResult = result as { artifacts?: { reviewSummary?: unknown }; rounds?: unknown[] };
    expect(typeof stepResult.artifacts?.reviewSummary).toBe("string");
    expect(stepResult.rounds).toHaveLength(0);
    expect(recordedRounds).toHaveLength(1);
    expect(recordedRounds[0]).toMatchObject({ trigger: "initial", findings: [] });
    expect(summaryOf(result)).toContain("**Risk: low**");
  });

  test("opens an observable phase per pass, grouped by round", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([], { understanding: "adds a --json flag" }),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
    );
    const { ctx, phases } = fakeCtx({ agent, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(phases.map((p) => p.label)).toEqual([
      "Context & intent",
      "Architecture & scope",
      "Correctness, tests & non-functional",
      "Structural maintainability",
    ]);
    expect(phases.every((p) => p.group === "initial")).toBe(true);
  });

  test("a fix round opens phases grouped by the fix and the verify", async () => {
    const agent = new FakeHarness();
    const auto = makeFinding("review", {
      severity: "warning",
      action: "auto-fix",
      title: "Tidy",
      detail: "Small cleanup.",
    });
    agent.responses.push(
      pass([], { understanding: "x" }),
      pass([auto], { verdict: "proceed" }), // architecture pass finds an auto-fix
      pass([]),
      pass([]),
      { ok: true, summary: "fixed", output: {} }, // fix pass
      pass([], { understanding: "x" }), // verify round
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
    );
    const { ctx, phases } = fakeCtx({ agent, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(phases.map((p) => p.group)).toEqual([
      "initial",
      "initial",
      "initial",
      "initial",
      "fix · attempt 1",
      "verify · attempt 1",
      "verify · attempt 1",
      "verify · attempt 1",
      "verify · attempt 1",
    ]);
    expect(phases.find((p) => p.group?.startsWith("fix"))?.label).toBe("Apply fixes");
  });

  test("threads the context pass understanding into the later passes", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([], { understanding: "MARKER-INTENT" }),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
    );
    const { ctx } = fakeCtx({ agent, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    for (const task of agent.tasks.slice(1)) expect(task).toContain("MARKER-INTENT");
  });

  test("runs post-context passes concurrently", async () => {
    class ConcurrentHarness extends FakeHarness {
      readonly pending: ((result: AgentResult) => void)[] = [];

      override run(task: string, opts?: AgentRunOpts): Promise<AgentResult> {
        this.tasks.push(task);
        this.opts.push(opts);
        if (this.tasks.length === 1) {
          return Promise.resolve(pass([], { understanding: "intent" }));
        }
        return new Promise((resolve) => this.pending.push(resolve));
      }
    }
    const agent = new ConcurrentHarness();
    const { ctx } = fakeCtx({ agent, reads: { prBody: "body" } });

    const running = reviewStep().run(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.tasks).toHaveLength(4);
    agent.pending[0]?.(pass([], { verdict: "proceed" }));
    agent.pending[1]?.(pass([]));
    agent.pending[2]?.(pass([]));
    await running;
  });

  test("feeds prior test step results into the correctness pass", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([], { understanding: "intent" }),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
    );
    const testFinding = makeFinding("test", {
      severity: "error",
      action: "ask-user",
      title: "Test failure",
      detail: "expected true to be false",
      location: "test/a.test.ts:12",
    });
    const { ctx } = fakeCtx({
      agent,
      reads: { prBody: "body" },
      rounds: [
        {
          step: "test",
          index: 0,
          trigger: "initial",
          findings: [testFinding],
        },
      ],
    });

    await reviewStep().run(ctx);

    expect(agent.tasks[2]).toContain("Prior test step result");
    expect(agent.tasks[2]).toContain("Test failure");
    expect(agent.tasks[2]).toContain("expected true to be false");
  });

  test("a block verdict surfaces a banner + high risk and requires approval", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([{ severity: "warning", action: "ask-user", title: "Too large", detail: "split it" }], {
        verdict: "block",
      }),
      pass([]),
      pass([]),
    );
    const { ctx, asks, approvals } = fakeCtx({ agent, reads: { prBody: "body" } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(summary).toContain("**Risk: high**");
    expect(summary.toLowerCase()).toContain("blocking concern");
    expect(asks).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.findings).toContainEqual(
      expect.objectContaining({ action: "ask-user", title: "Too large" }),
    );
    expect(approvals[0]?.findings).toContainEqual(
      expect.objectContaining({ action: "ask-user", title: "Blocking architecture verdict" }),
    );
    expect(agent.tasks).toHaveLength(4); // ask-user is not auto-fix, so no fix pass
  });

  test("a bare block verdict adds an approval finding", async () => {
    const agent = new FakeHarness();
    agent.responses.push(pass([]), pass([], { verdict: "block" }), pass([]), pass([]));
    const { ctx, approvals, recordedRounds } = fakeCtx({ agent, reads: { prBody: "body" } });

    const result = await reviewStep().run(ctx);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.findings).toMatchObject([
      { severity: "error", action: "ask-user", title: "Blocking architecture verdict" },
    ]);
    expect(recordedRounds[0]?.findings).toMatchObject([
      { action: "ask-user", title: "Blocking architecture verdict" },
    ]);
    expect(summaryOf(result)).toContain("Blocking architecture verdict");
  });

  test("a block verdict stays visible when another pass already needs user approval", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([], { verdict: "block" }),
      pass([
        { severity: "warning", action: "ask-user", title: "Confirm behavior", detail: "intent?" },
      ]),
      pass([]),
    );
    const { ctx, approvals } = fakeCtx({ agent, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(approvals[0]?.findings).toContainEqual(
      expect.objectContaining({ title: "Confirm behavior" }),
    );
    expect(approvals[0]?.findings).toContainEqual(
      expect.objectContaining({ title: "Blocking architecture verdict" }),
    );
  });

  test("runs the fix pass for auto-fix findings, then verifies with fresh passes", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([
        { severity: "warning", action: "auto-fix", title: "Off-by-one", detail: "loop overruns" },
      ]),
      pass([]),
      { ok: true, summary: "fixed the off-by-one" }, // the fix pass reply
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
    );
    const { ctx, recordedRounds } = fakeCtx({ agent, reads: { prBody: "body" } });

    const result = await reviewStep().run(ctx);
    const summary = summaryOf(result);

    expect(agent.tasks).toHaveLength(9);
    expect(agent.opts[4]?.schema).toBeUndefined(); // the fix pass requests no schema
    expect(agent.tasks[4]).toContain("Prior review round history");
    expect(agent.tasks[4]).toContain("Round 0: initial");
    expect(agent.tasks[5]).toContain("Prior review round history");
    expect(recordedRounds.map((r) => r.trigger)).toEqual(["initial", "auto_fix", "verify"]);
    expect(summary).toContain("fixed the off-by-one");
  });

  test("lists ask-user findings in the summary but never fixes them", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([
        { severity: "warning", action: "ask-user", title: "Confirm contract", detail: "intent?" },
      ]),
      pass([]),
    );
    const { ctx, approvals } = fakeCtx({ agent, reads: { prBody: "body" } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(approvals).toHaveLength(1);
    expect(agent.tasks).toHaveLength(4); // no fix pass ran
    expect(summary).toContain("Confirm contract");
  });

  test("deduplicates overlapping findings before fixing and summarizing", async () => {
    const duplicate = {
      severity: "warning",
      action: "auto-fix",
      title: "Guard empty input",
      detail: "same issue from two lenses",
      location: "src/a.ts:10",
    };
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([duplicate]),
      pass([duplicate]),
      { ok: true, summary: "fixed the guard" },
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
    );
    const { ctx, recordedRounds } = fakeCtx({ agent, reads: { prBody: "body" } });

    const result = await reviewStep().run(ctx);

    const fixList = agent.tasks[4]?.split("\n\nFindings:\n").at(1) ?? "";
    expect(fixList.match(/Guard empty input/g) ?? []).toHaveLength(1);
    expect(recordedRounds[0]?.findings).toHaveLength(1);
    expect(summaryOf(result)).toContain("fixed the guard");
  });

  test("reverts and warns when a read-only pass modifies the worktree", async () => {
    // The worktree is clean when review starts but dirty once the passes have run - i.e. a
    // supposedly read-only pass edited a file despite the prompt.
    class DirtyingGit extends FakeGit {
      private statusCalls = 0;
      override status() {
        this.statusCalls += 1;
        return Promise.resolve({
          branch: this.currentBranchName,
          staged: [],
          unstaged: this.statusCalls > 1 ? ["rogue.ts"] : [],
        });
      }
    }
    const git = new DirtyingGit();
    const agent = new FakeHarness();
    agent.responses.push(pass([]), pass([], { verdict: "proceed" }), pass([]), pass([]));
    const { ctx, logs } = fakeCtx({ agent, git, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(git.calls).toContain("discardChanges");
    expect(logs.some((l) => l.toLowerCase().includes("modified the worktree"))).toBe(true);
  });

  test("does not revert when the read-only passes leave the worktree untouched", async () => {
    const git = new FakeGit(); // status stays clean across both checks
    const agent = new FakeHarness();
    agent.responses.push(pass([]), pass([], { verdict: "proceed" }), pass([]), pass([]));
    const { ctx } = fakeCtx({ agent, git, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(git.calls).not.toContain("discardChanges");
  });
});
