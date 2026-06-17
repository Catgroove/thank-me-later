import { describe, expect, test } from "bun:test";
import type { PullRequest } from "@tml/core";
import { describeStep } from "../src/steps/describe.ts";
import { FakeForge, FakeHarness, fakeCtx } from "./fake-ctx.ts";

const reads = { branchName: "tml/ship-abc1234" };

describe("describe step", () => {
  test("produces the PR title + body from one agent call when no PR exists yet", async () => {
    const agent = new FakeHarness();
    agent.result = {
      ok: true,
      summary: "described",
      output: { title: "feat: add --json flag", body: "Adds a `--json` output mode." },
    };
    const { ctx } = fakeCtx({ agent, reads });

    const result = await describeStep().run(ctx);

    expect(result).toEqual({
      prTitle: "feat: add --json flag",
      prBody: "Adds a `--json` output mode.",
    });
    expect(agent.tasks).toHaveLength(1);
  });

  test("trims the agent-provided title and body", async () => {
    const agent = new FakeHarness();
    agent.result = {
      ok: true,
      summary: "described",
      output: { title: "  feat: add --json flag  ", body: "\nAdds JSON output.\n" },
    };
    const { ctx } = fakeCtx({ agent, reads });

    const result = await describeStep().run(ctx);

    expect(result).toEqual({ prTitle: "feat: add --json flag", prBody: "Adds JSON output." });
  });

  test("reuses the open PR's description on a re-entry (no agent call, no clobber)", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const existing: PullRequest = {
      number: 7,
      url: "https://forge.test/pr/7",
      head: "tml/ship-abc1234",
      base: "main",
      title: "feat: existing title",
      body: "A human-edited body\n\n<!-- tml:review -->old block<!-- /tml:review -->",
      state: "open",
      mergeable: "mergeable",
      reviewDecision: null,
      headSha: "headsha",
      checks: [],
      threads: [],
    };
    forge.existing = existing;
    const { ctx, logs } = fakeCtx({ agent, forge, reads });

    const result = await describeStep().run(ctx);

    expect(result).toEqual({ prTitle: existing.title, prBody: existing.body });
    expect(agent.tasks).toHaveLength(0); // skipped the agent entirely
    expect(logs.some((l) => l.includes("reusing"))).toBe(true);
  });

  test("throws if the agent doesn't return a usable { title, body }", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: true, summary: "oops", output: { title: "   ", body: "body" } };
    const { ctx } = fakeCtx({ agent, reads });

    const error = await describeStep()
      .run(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("{ title, body }");
  });
});
