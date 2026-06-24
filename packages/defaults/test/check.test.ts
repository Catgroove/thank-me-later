import { describe, expect, test } from "bun:test";
import { makeFinding, type Finding } from "@tml/core";
import { checkStep, qualityStep, testStep } from "../src/steps/check.ts";
import { checkFindingsSchema, qualityPrompt } from "../src/prompts.ts";
import { FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

describe("checkStep", () => {
  test("runs a fresh structured check prompt and returns a clean round on success", async () => {
    const agent = new FakeHarness();
    agent.responses.push({ ok: true, summary: "clean", output: { findings: [] } });
    const { ctx, asks } = fakeCtx({ agent });

    const result = await checkStep("quality", qualityPrompt).run(ctx);

    expect(result).toEqual({
      artifacts: {},
      rounds: [{ trigger: "initial", findings: [], testingSummary: "clean", tested: false }],
    });
    expect(agent.tasks).toHaveLength(1);
    expect(agent.tasks[0]).toContain("Check step: quality");
    expect(agent.tasks[0]).toContain(qualityPrompt);
    expect(agent.opts).toEqual([{ schema: checkFindingsSchema }]);
    expect(asks).toEqual([]);
  });

  test("returns an ask-user finding when a non-ok check has no structured output", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: false, summary: "quality failures remain" };
    const { ctx, asks, approvals } = fakeCtx({ agent });

    const result = await checkStep("quality", "check quality").run(ctx);

    expect(asks).toEqual([]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.findings).toMatchObject([
      {
        disposition: "blocker",
        action: "ask-user",
        title: "quality check did not return structured findings",
        detail: "quality failures remain",
      },
    ]);
    expect(result).toMatchObject({
      artifacts: {},
      rounds: [
        {
          trigger: "initial",
          findings: [
            {
              disposition: "blocker",
              action: "ask-user",
              title: "quality check did not return structured findings",
              detail: "quality failures remain",
            },
          ],
        },
        {
          trigger: "approval",
          resolution: "approved",
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
              disposition: "should-fix",
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

    const result = await checkStep("quality", qualityPrompt).run(ctx);

    expect(agent.tasks).toHaveLength(3);
    expect(agent.tasks[0]).toContain("Check step: quality");
    expect(agent.tasks[1]).toContain("Fix step: quality");
    expect(agent.tasks[1]).toContain("Formatting drift");
    expect(agent.tasks[2]).toContain("Prior check round history");
    expect(git.calls).toContain("stageAll");
    expect(git.calls).toContain("commit chore(quality): formatted src/a.ts");
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

  test("informational findings do not require approval", async () => {
    const agent = new FakeHarness();
    agent.responses.push({
      ok: true,
      summary: "info",
      output: {
        findings: [
          {
            disposition: "nit",
            action: "no-op",
            title: "FYI",
            detail: "informational only",
          },
        ],
      },
    });
    const { ctx, approvals } = fakeCtx({ agent });

    const result = await checkStep("quality", "check quality").run(ctx);

    expect(approvals).toEqual([]);
    expect(result).toMatchObject({
      artifacts: {},
      rounds: [{ trigger: "initial", findings: [{ action: "no-op", title: "FYI" }] }],
    });
  });

  test("approval abort throws so the run fails", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: false, summary: "quality failures remain" };
    const { ctx } = fakeCtx({
      agent,
      approveFindings: () => Promise.resolve({ action: "abort" }),
    });

    try {
      await checkStep("quality", "check quality").run(ctx);
      throw new Error("check step unexpectedly resolved");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toContain(
        "approval aborted by operator",
      );
    }
  });

  test("approval approve records notes and user-authored findings", async () => {
    const agent = new FakeHarness();
    agent.result = { ok: false, summary: "quality failures remain" };
    const userFinding = makeFinding("user", {
      disposition: "should-fix",
      action: "no-op",
      title: "Known follow-up",
      detail: "Track separately",
    });
    const { ctx } = fakeCtx({
      agent,
      approveFindings: (input) =>
        Promise.resolve({
          action: "approve",
          notes: { [input.findings[0]?.id ?? "missing"]: "accepted risk" },
          userFindings: [userFinding],
        }),
    });

    const result = await checkStep("quality", "check quality").run(ctx);
    const rounds = (
      result as { rounds?: { userNotes?: Record<string, string>; findings?: Finding[] }[] }
    ).rounds;
    const findingId = rounds?.[0]?.findings?.[0]?.id ?? "missing";

    expect(rounds?.[1]?.userNotes).toEqual({ [findingId]: "accepted risk" });
    expect(rounds?.[1]?.findings).toContainEqual(userFinding);
  });

  test("approval fix runs a user-selected fix and then verifies fresh", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      {
        ok: true,
        summary: "needs input",
        output: {
          findings: [
            {
              disposition: "should-fix",
              action: "ask-user",
              title: "Choose contract",
              detail: "needs operator selection",
            },
          ],
        },
      },
      { ok: true, summary: "fixed selected finding" },
      { ok: true, summary: "clean", output: { findings: [] } },
    );
    const git = new FakeGit();
    git.stagedFiles = ["src/a.ts"];
    const { ctx } = fakeCtx({
      agent,
      git,
      approveFindings: (input) =>
        Promise.resolve({ action: "fix", selectedFindingIds: [input.findings[0]?.id ?? ""] }),
    });

    const result = await checkStep("quality", "check quality").run(ctx);

    expect(agent.tasks).toHaveLength(3);
    expect(agent.tasks[1]).toContain("Fix step: quality");
    expect(agent.tasks[2]).toContain("Prior check round history");
    expect(result).toMatchObject({
      rounds: [
        { trigger: "initial", findings: [{ title: "Choose contract" }] },
        { trigger: "approval", findings: [{ title: "Choose contract" }] },
        { trigger: "user_fix", fixSummary: "fixed selected finding" },
        { trigger: "verify", findings: [] },
      ],
    });
  });

  test("approval fix asks again when fresh verification still needs a decision", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      {
        ok: true,
        summary: "needs input",
        output: {
          findings: [
            {
              disposition: "should-fix",
              action: "ask-user",
              title: "Choose contract",
              detail: "needs operator selection",
            },
          ],
        },
      },
      { ok: true, summary: "fixed selected finding" },
      {
        ok: true,
        summary: "still needs input",
        output: {
          findings: [
            {
              disposition: "should-fix",
              action: "ask-user",
              title: "Confirm follow-up",
              detail: "still pending",
            },
          ],
        },
      },
    );
    const git = new FakeGit();
    git.stagedFiles = ["src/a.ts"];
    let approvals = 0;
    const { ctx } = fakeCtx({
      agent,
      git,
      approveFindings: (input) => {
        approvals += 1;
        return Promise.resolve(
          approvals === 1
            ? { action: "fix", selectedFindingIds: [input.findings[0]?.id ?? ""] }
            : { action: "approve" },
        );
      },
    });

    const result = await checkStep("quality", "check quality").run(ctx);

    expect(approvals).toBe(2);
    expect(agent.tasks).toHaveLength(3);
    expect(result).toMatchObject({
      rounds: [
        { trigger: "initial", findings: [{ title: "Choose contract" }] },
        { trigger: "approval", findings: [{ title: "Choose contract" }] },
        { trigger: "user_fix", fixSummary: "fixed selected finding" },
        { trigger: "verify", findings: [{ title: "Confirm follow-up" }] },
        { trigger: "approval", resolution: "approved" },
      ],
    });
  });

  test("approval prompts only suggest current selected findings", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      {
        ok: true,
        summary: "auto fix first",
        output: {
          findings: [
            { disposition: "should-fix", action: "auto-fix", title: "A", detail: "fix A" },
          ],
        },
      },
      { ok: true, summary: "fixed A" },
      {
        ok: true,
        summary: "needs input",
        output: {
          findings: [
            { disposition: "should-fix", action: "ask-user", title: "B", detail: "decide B" },
          ],
        },
      },
    );
    const git = new FakeGit();
    git.stagedFiles = ["src/a.ts"];
    const suggested: (readonly string[] | undefined)[] = [];
    const { ctx } = fakeCtx({
      agent,
      git,
      approveFindings: (input) => {
        suggested.push(input.suggestedFindingIds);
        return Promise.resolve({ action: "approve" });
      },
    });

    await checkStep("quality", "check quality").run(ctx);

    expect(suggested).toEqual([undefined]);
  });

  test("approval fix notes are included in the fix prompt", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      {
        ok: true,
        summary: "needs input",
        output: {
          findings: [
            { disposition: "should-fix", action: "ask-user", title: "B", detail: "decide B" },
          ],
        },
      },
      { ok: true, summary: "fixed B" },
      { ok: true, summary: "clean", output: { findings: [] } },
    );
    const git = new FakeGit();
    git.stagedFiles = ["src/a.ts"];
    const { ctx } = fakeCtx({
      agent,
      git,
      approveFindings: (input) =>
        Promise.resolve({
          action: "fix",
          selectedFindingIds: [input.findings[0]?.id ?? ""],
          notes: { [input.findings[0]?.id ?? ""]: "Use the public API." },
        }),
    });

    await checkStep("quality", "check quality").run(ctx);

    expect(agent.tasks[1]).toContain("Operator note: Use the public API.");
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

    await checkStep("quality", qualityPrompt).run(ctx);

    git.status = originalStatus;
    expect(git.calls).toContain("discardChanges");
    expect(logs).toEqual([
      "warning: a check round modified the worktree; reverting before continuing",
    ]);
  });

  test("the named checks carry the right names", () => {
    expect([qualityStep().name, testStep().name]).toEqual(["quality", "test"]);
  });
});
