import { describe, expect, test } from "bun:test";
import { makeFinding, type AgentResult } from "@tml/core";
import { findingsSchema } from "../src/prompts.ts";
import { reviewStep } from "../src/steps/review.ts";
import { FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

/** A scripted review-pass reply: structured `output` against the findings schema. */
function pass(findings: unknown[]): AgentResult {
  return { ok: true, summary: "pass done", output: { findings } };
}

function summaryOf(result: unknown): string {
  const output = result as { artifacts?: { reviewSummary?: unknown }; reviewSummary?: unknown };
  const value = output.artifacts?.reviewSummary ?? output.reviewSummary;
  return typeof value === "string" ? value : "";
}

describe("review step", () => {
  test("runs one read-only thermo-nuclear review pass", async () => {
    const agent = new FakeHarness();
    agent.responses.push(pass([]));
    const git = new FakeGit();
    const { ctx, asks, recordedRounds } = fakeCtx({
      agent,
      git,
      reads: { prBody: "Adds --json output" },
    });

    const result = await reviewStep().run(ctx);

    expect(agent.tasks).toHaveLength(1);
    expect(git.calls).not.toContain("diffAgainst main");
    expect(git.calls).toContain("diffAgainstInstructions main");
    expect(agent.tasks[0]).toContain("Thermo-nuclear code quality review");
    expect(agent.tasks[0]).toContain("git diff --find-renames main...HEAD --");
    expect(agent.tasks[0]).toContain("Adds --json output");
    expect(agent.opts[0]?.schema).toBe(findingsSchema);
    expect(asks).toHaveLength(0);
    const stepResult = result as { artifacts?: { reviewSummary?: unknown }; rounds?: unknown[] };
    expect(typeof stepResult.artifacts?.reviewSummary).toBe("string");
    expect(stepResult.rounds).toHaveLength(0);
    expect(recordedRounds).toHaveLength(1);
    expect(recordedRounds[0]).toMatchObject({ trigger: "initial", findings: [] });
    expect(summaryOf(result)).toContain("**Risk: low**");
  });

  test("opens one observable phase grouped by round", async () => {
    const agent = new FakeHarness();
    agent.responses.push(pass([]));
    const { ctx, phases } = fakeCtx({ agent, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(phases.map((p) => p.label)).toEqual(["Thermo-nuclear code quality review"]);
    expect(phases.map((p) => p.group)).toEqual(["initial"]);
  });

  test("runs the fix pass for auto-fix findings, then verifies with a fresh review", async () => {
    const agent = new FakeHarness();
    const auto = makeFinding("review", {
      disposition: "should-fix",
      action: "auto-fix",
      title: "Tidy",
      detail: "Small cleanup.",
    });
    agent.responses.push(pass([auto]), { ok: true, summary: "fixed", output: {} }, pass([]));
    const { ctx, phases, recordedRounds } = fakeCtx({ agent, reads: { prBody: "body" } });

    const result = await reviewStep().run(ctx);

    expect(agent.tasks).toHaveLength(3);
    expect(agent.opts[1]?.schema).toBeUndefined();
    expect(agent.tasks[1]).toContain("Prior review round history");
    expect(agent.tasks[1]).toContain("Round 0: initial");
    expect(agent.tasks[2]).toContain("Prior review round history");
    expect(phases.map((p) => p.group)).toEqual([
      "initial",
      "fix · attempt 1",
      "verify · attempt 1",
    ]);
    expect(phases.find((p) => p.group?.startsWith("fix"))?.label).toBe("Apply fixes");
    expect(recordedRounds.map((r) => r.trigger)).toEqual(["initial", "auto_fix", "verify"]);
    expect(summaryOf(result)).toContain("fixed");
  });

  test("lists ask-user findings in the summary but never fixes them", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([
        {
          disposition: "should-fix",
          action: "ask-user",
          title: "Confirm contract",
          detail: "intent?",
        },
      ]),
    );
    const { ctx, approvals } = fakeCtx({ agent, reads: { prBody: "body" } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(approvals).toHaveLength(1);
    expect(agent.tasks).toHaveLength(1);
    expect(summary).toContain("Confirm contract");
  });

  test("reverts and warns when the read-only pass modifies the worktree", async () => {
    // The worktree is clean when review starts but dirty once the pass has run.
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
    agent.responses.push(pass([]));
    const { ctx, logs } = fakeCtx({ agent, git, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(git.calls).toContain("discardChanges");
    expect(logs.some((l) => l.toLowerCase().includes("modified the worktree"))).toBe(true);
  });

  test("does not revert when the read-only pass leaves the worktree untouched", async () => {
    const git = new FakeGit();
    const agent = new FakeHarness();
    agent.responses.push(pass([]));
    const { ctx } = fakeCtx({ agent, git, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(git.calls).not.toContain("discardChanges");
  });
});
