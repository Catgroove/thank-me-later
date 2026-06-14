import { describe, expect, test } from "bun:test";
import { reviewStep } from "../src/steps/review.ts";
import { reviewPrompt } from "../src/prompts.ts";
import { FakeHarness, fakeCtx } from "./fake-ctx.ts";

describe("review step", () => {
  test("runs the review prompt and produces the summary", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: true, summary: "Looks good; fixed an off-by-one." };
    const { ctx } = fakeCtx({ agent });

    const result = await reviewStep().run(ctx);

    expect(agent.tasks).toEqual([reviewPrompt]);
    expect(result).toEqual({ reviewSummary: "Looks good; fixed an off-by-one." });
  });
});
