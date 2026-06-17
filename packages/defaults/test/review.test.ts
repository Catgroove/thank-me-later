import { describe, expect, test } from "bun:test";
import type { AgentResult } from "@tml/core";
import { reviewStep } from "../src/steps/review.ts";
import { findingsSchema } from "../src/prompts.ts";
import { FakeHarness, fakeCtx } from "./fake-ctx.ts";

/** A scripted review-pass reply: structured `output` against the findings schema. */
function pass(findings: unknown[], extra: Record<string, unknown> = {}): AgentResult {
  return { ok: true, summary: "pass done", output: { findings, ...extra } };
}

function summaryOf(result: unknown): string {
  return (result as { reviewSummary: string }).reviewSummary;
}

describe("review step", () => {
  test("runs five read-only passes in order, each requesting the findings schema", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([], { understanding: "adds a --json flag" }),
      pass([], { verdict: "proceed" }),
      pass([]),
      pass([]),
      pass([]),
    );
    const { ctx, asks } = fakeCtx({ agent, reads: { prBody: "Adds --json output" } });

    const result = await reviewStep().run(ctx);

    expect(agent.tasks).toHaveLength(5); // no fix pass — no auto-fix findings
    for (let i = 0; i < 5; i++) expect(agent.opts[i]?.schema).toBe(findingsSchema);
    expect(asks).toHaveLength(0); // the gate never calls ctx.ask
    expect(summaryOf(result)).toContain("**Risk: low**");
  });

  test("threads the context pass understanding into the later passes", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([], { understanding: "MARKER-INTENT" }),
      pass([]),
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
    const { ctx, asks } = fakeCtx({ agent, reads: { prBody: "body" } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(summary).toContain("**Risk: high**");
    expect(summary.toLowerCase()).toContain("blocking concern");
    expect(asks).toHaveLength(0);
    expect(agent.tasks).toHaveLength(5); // ask-user is not auto-fix → no fix pass
  });

  test("runs the fix pass only when there are auto-fix findings", async () => {
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
    );
    const { ctx } = fakeCtx({ agent, reads: { prBody: "body" } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(agent.tasks).toHaveLength(6);
    expect(agent.opts[5]?.schema).toBeUndefined(); // the fix pass requests no schema
    expect(summary).toContain("fixed the off-by-one");
  });

  test("lists ask-user findings in the summary but never fixes them", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([]),
      pass([
        { severity: "warning", action: "ask-user", title: "Confirm contract", detail: "intent?" },
      ]),
      pass([]),
      pass([]),
    );
    const { ctx } = fakeCtx({ agent, reads: { prBody: "body" } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(agent.tasks).toHaveLength(5); // no fix pass ran
    expect(summary).toContain("Confirm contract");
  });
});
