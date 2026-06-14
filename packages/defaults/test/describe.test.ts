import { describe, expect, test } from "bun:test";
import { describeStep } from "../src/steps/describe.ts";
import { FakeHarness, fakeCtx } from "./fake-ctx.ts";

describe("describe step", () => {
  test("produces the PR title + body from one agent call", async () => {
    const agent = new FakeHarness();
    agent.result = {
      ok: true,
      summary: "described",
      output: { title: "feat: add --json flag", body: "Adds a `--json` output mode." },
    };
    const { ctx } = fakeCtx({ agent });

    const result = await describeStep().run(ctx);

    expect(result).toEqual({
      prTitle: "feat: add --json flag",
      prBody: "Adds a `--json` output mode.",
    });
    expect(agent.tasks).toHaveLength(1);
  });

  test("throws if the agent doesn't return a { title, body }", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: true, summary: "oops", output: { title: 123 } };
    const { ctx } = fakeCtx({ agent });

    const error = await describeStep()
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("{ title, body }");
  });
});
