import { describe, expect, test } from "bun:test";
import { checkStep, formatStep, lintStep, testStep, typecheckStep } from "../src/steps/check.ts";
import { formatPrompt } from "../src/prompts.ts";
import { FakeHarness, fakeCtx } from "./fake-ctx.ts";

describe("checkStep", () => {
  test("runs the agent with its prompt and does not escalate on success", async () => {
    const agent = new FakeHarness();
    const { ctx, asks } = fakeCtx({ agent });

    const result = await checkStep("format", formatPrompt).run(ctx);

    expect(result).toEqual({});
    expect(agent.tasks).toEqual([formatPrompt]);
    expect(asks).toEqual([]);
  });

  test("escalates via ctx.ask when the agent result is not ok", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: false, summary: "lint failures remain" };
    const { ctx, asks } = fakeCtx({ agent });

    await checkStep("lint", "lint it").run(ctx);

    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain("lint failures remain");
  });

  test("the four named checks carry the right names", () => {
    expect([formatStep().name, lintStep().name, typecheckStep().name, testStep().name]).toEqual([
      "format",
      "lint",
      "typecheck",
      "test",
    ]);
  });
});
