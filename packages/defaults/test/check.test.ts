import { describe, expect, test } from "bun:test";
import { checkStep, formatStep, lintStep, testStep, typecheckStep } from "../src/steps/check.ts";
import { checkFindingsSchema, formatPrompt } from "../src/prompts.ts";
import { FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

describe("checkStep", () => {
  test("runs a fresh structured check prompt and returns a clean round on success", async () => {
    const agent = new FakeHarness();
    agent.responses.push({ ok: true, summary: "clean", output: { findings: [] } });
    const { ctx, asks } = fakeCtx({ agent });

    const result = await checkStep("format", formatPrompt).run(ctx);

    expect(result).toEqual({ artifacts: {}, rounds: [{ trigger: "initial", findings: [] }] });
    expect(agent.tasks).toHaveLength(1);
    expect(agent.tasks[0]).toContain("Check step: format");
    expect(agent.tasks[0]).toContain(formatPrompt);
    expect(agent.opts).toEqual([{ schema: checkFindingsSchema }]);
    expect(asks).toEqual([]);
  });

  test("returns an ask-user finding when a non-ok check has no structured output", async () => {
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
              title: "lint check did not return structured findings",
              detail: "lint failures remain",
            },
          ],
        },
      ],
    });
  });

  test("fixes auto-fix findings in a fresh fix round and verifies in a fresh check round", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      {
        ok: true,
        summary: "formatting needed",
        output: {
          findings: [
            {
              severity: "warning",
              action: "auto-fix",
              title: "Formatting drift",
              detail: "src/a.ts is not formatted",
              location: "src/a.ts",
            },
          ],
        },
      },
      { ok: true, summary: "formatted src/a.ts" },
      { ok: true, summary: "clean", output: { findings: [] } },
    );
    const git = new FakeGit();
    git.stagedFiles = ["src/a.ts"];
    git.commitSha = "abc";
    const { ctx } = fakeCtx({ agent, git });

    const result = await checkStep("format", formatPrompt).run(ctx);

    expect(agent.tasks).toHaveLength(3);
    expect(agent.tasks[0]).toContain("Check step: format");
    expect(agent.tasks[1]).toContain("Fix step: format");
    expect(agent.tasks[1]).toContain("Formatting drift");
    expect(agent.tasks[2]).toContain("Prior check round history");
    expect(git.calls).toContain("stageAll");
    expect(git.calls).toContain("commit chore: apply fixes from format");
    expect(result).toMatchObject({
      rounds: [
        {
          trigger: "initial",
          findings: [{ action: "auto-fix", title: "Formatting drift" }],
        },
        {
          trigger: "auto_fix",
          findings: [{ action: "auto-fix", title: "Formatting drift" }],
          fixSummary: "formatted src/a.ts",
          commitSha: "abc",
        },
        { trigger: "verify", findings: [] },
      ],
    });
  });

  test("reverts edits made during check rounds", async () => {
    const agent = new FakeHarness();
    agent.responses.push({ ok: true, summary: "clean", output: { findings: [] } });
    const git = new FakeGit();
    const originalStatus = git.status.bind(git);
    let calls = 0;
    git.status = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ branch: "HEAD", staged: [], unstaged: [] });
      return Promise.resolve({ branch: "HEAD", staged: [], unstaged: ["src/a.ts"] });
    };
    const { ctx, logs } = fakeCtx({ agent, git });

    await checkStep("format", formatPrompt).run(ctx);

    git.status = originalStatus;
    expect(git.calls).toContain("discardChanges");
    expect(logs).toEqual([
      "warning: a check round modified the worktree; reverting before continuing",
    ]);
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
