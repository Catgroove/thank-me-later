import { describe, expect, test } from "bun:test";
import { checkStep, formatStep, lintStep, testStep, typecheckStep } from "../src/steps/check.ts";
import { formatPrompt } from "../src/prompts.ts";
import { FakeHarness, fakeCtx } from "./fake-ctx.ts";

describe("checkStep", () => {
  test("runs the agent with its prompt and returns a clean round on success", async () => {
    const agent = new FakeHarness();
    const { ctx, asks } = fakeCtx({ agent });

    const result = await checkStep("format", formatPrompt).run(ctx);

    expect(result).toEqual({ artifacts: {}, rounds: [{ trigger: "initial", findings: [] }] });
    expect(agent.tasks).toEqual([formatPrompt]);
    expect(asks).toEqual([]);
  });

  test("returns an ask-user finding when the agent result is not ok", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: false, summary: "lint failures remain" };
    const { ctx, asks } = fakeCtx({ agent });

    const result = await checkStep("lint", "lint it").run(ctx);

    expect(asks).toEqual([]);
    expect(result).toMatchObject({
      artifacts: {},
      rounds: [
        {
          trigger: "initial",
          findings: [
            {
              severity: "error",
              action: "ask-user",
              title: "lint incomplete",
              detail: "lint failures remain",
            },
          ],
        },
      ],
    });
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
