import { describe, expect, test } from "bun:test";
import type { AgentResult } from "@tml/core";
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
  test("runs five read-only passes in order, the architecture pass requiring a verdict", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([], { understanding: "adds a --json flag" }),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
      pass([]),
    );
    const { ctx, asks } = fakeCtx({
      agent,
      reads: { prBody: "Adds --json output" },
    });

    const result = await reviewStep().run(ctx);

    expect(agent.tasks).toHaveLength(5); // no fix pass - no auto-fix findings
    expect(agent.opts[1]?.schema).toBe(architectureSchema); // architecture: verdict required
    for (const i of [0, 2, 3, 4]) expect(agent.opts[i]?.schema).toBe(findingsSchema);
    expect(asks).toHaveLength(0); // the gate never calls ctx.ask
    const stepResult = result as { artifacts?: { reviewSummary?: unknown }; rounds?: unknown[] };
    expect(typeof stepResult.artifacts?.reviewSummary).toBe("string");
    expect(stepResult.rounds).toHaveLength(1);
    expect(stepResult.rounds?.[0]).toMatchObject({ trigger: "initial", findings: [] });
    expect(summaryOf(result)).toContain("**Risk: low**");
  });

  test("threads the context pass understanding into the later passes", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([], { understanding: "MARKER-INTENT" }),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
      pass([]),
    );
    const { ctx } = fakeCtx({ agent, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    for (const task of agent.tasks.slice(1)) expect(task).toContain("MARKER-INTENT");
  });

  test("a block verdict surfaces a banner + high risk without halting or asking", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([{ severity: "warning", action: "ask-user", title: "Too large", detail: "split it" }], {
        verdict: "block",
      }),
      pass([]),
      pass([]),
      pass([]),
    );
    const { ctx, asks, approvals } = fakeCtx({ agent, reads: { prBody: "body" } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(summary).toContain("**Risk: high**");
    expect(summary.toLowerCase()).toContain("blocking concern");
    expect(asks).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.findings).toMatchObject([{ action: "ask-user", title: "Too large" }]);
    expect(agent.tasks).toHaveLength(5); // ask-user is not auto-fix, so no fix pass
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
      pass([]),
      { ok: true, summary: "fixed the off-by-one" }, // the fix pass reply
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
      pass([]),
    );
    const { ctx } = fakeCtx({ agent, reads: { prBody: "body" } });

    const result = await reviewStep().run(ctx);
    const summary = summaryOf(result);
    const stepResult = result as { rounds?: { trigger?: string }[] };

    expect(agent.tasks).toHaveLength(11);
    expect(agent.opts[5]?.schema).toBeUndefined(); // the fix pass requests no schema
    expect(agent.tasks[5]).toContain("Prior review round history");
    expect(agent.tasks[5]).toContain("Round 0: initial");
    expect(agent.tasks[6]).toContain("Prior review round history");
    expect(stepResult.rounds?.map((r) => r.trigger)).toEqual(["initial", "auto_fix", "verify"]);
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
      pass([]),
    );
    const { ctx, approvals } = fakeCtx({ agent, reads: { prBody: "body" } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(approvals).toHaveLength(1);
    expect(agent.tasks).toHaveLength(5); // no fix pass ran
    expect(summary).toContain("Confirm contract");
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
    agent.responses.push(pass([]), pass([], { verdict: "proceed" }), pass([]), pass([]), pass([]));
    const { ctx, logs } = fakeCtx({ agent, git, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(git.calls).toContain("discardChanges");
    expect(logs.some((l) => l.toLowerCase().includes("modified the worktree"))).toBe(true);
  });

  test("does not revert when the read-only passes leave the worktree untouched", async () => {
    const git = new FakeGit(); // status stays clean across both checks
    const agent = new FakeHarness();
    agent.responses.push(pass([]), pass([], { verdict: "proceed" }), pass([]), pass([]), pass([]));
    const { ctx } = fakeCtx({ agent, git, reads: { prBody: "body" } });

    await reviewStep().run(ctx);

    expect(git.calls).not.toContain("discardChanges");
  });
});
