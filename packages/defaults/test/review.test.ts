import { describe, expect, test } from "bun:test";
import type { AgentResult, PullRequest } from "@tml/core";
import { reviewStep } from "../src/steps/review.ts";
import { architectureSchema, findingsSchema } from "../src/prompts.ts";
import { findingKey, findingMarker } from "../src/review/threads.ts";
import { FakeForge, FakeGit, FakeHarness, fakeCtx } from "./fake-ctx.ts";

/** A scripted review-pass reply: structured `output` against the findings schema. */
function pass(findings: unknown[], extra: Record<string, unknown> = {}): AgentResult {
  return { ok: true, summary: "pass done", output: { findings, ...extra } };
}

function summaryOf(result: unknown): string {
  return (result as { reviewSummary: string }).reviewSummary;
}

/** A minimal open PR the review step reads (number + body are all it touches). */
function prWith(body: string): PullRequest {
  return {
    number: 5,
    url: "https://forge.test/pr/5",
    head: "feat/x",
    base: "main",
    title: "t",
    body,
    state: "open",
    mergeable: "mergeable",
    reviewDecision: null,
    headSha: "headsha",
    checks: [],
    threads: [],
  };
}

/** The five clean passes (context understanding, architecture proceed, three empty). */
function cleanPasses(): AgentResult[] {
  return [
    pass([], { understanding: "adds a --json flag" }),
    pass([], { verdict: "proceed" }),
    pass([]),
    pass([]),
    pass([]),
  ];
}

describe("review step", () => {
  test("runs five read-only passes in order, the architecture pass requiring a verdict", async () => {
    const agent = new FakeHarness();
    agent.responses.push(...cleanPasses());
    const { ctx, asks } = fakeCtx({
      agent,
      reads: { prBody: "Adds --json output", pullRequest: prWith("body") },
    });

    const result = await reviewStep().run(ctx);

    expect(agent.tasks).toHaveLength(5); // no fix pass — no auto-fix findings
    expect(agent.opts[1]?.schema).toBe(architectureSchema); // architecture: verdict required
    for (const i of [0, 2, 3, 4]) expect(agent.opts[i]?.schema).toBe(findingsSchema);
    expect(asks).toHaveLength(0); // the gate never calls ctx.ask
    expect(summaryOf(result)).toContain("**Risk: low**");
  });

  test("strips the prior review block before building the context prompt", async () => {
    const agent = new FakeHarness();
    agent.responses.push(...cleanPasses());
    const body = "Human description.\n\n<!-- tml:review -->\nSTALE FINDING\n<!-- /tml:review -->";
    const { ctx } = fakeCtx({ agent, reads: { prBody: body, pullRequest: prWith(body) } });

    await reviewStep().run(ctx);

    expect(agent.tasks[0]).toContain("Human description.");
    expect(agent.tasks[0]).not.toContain("STALE FINDING");
    expect(agent.tasks[0]).not.toContain("tml:review");
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
    const { ctx } = fakeCtx({ agent, reads: { prBody: "body", pullRequest: prWith("body") } });

    await reviewStep().run(ctx);

    for (const task of agent.tasks.slice(1)) expect(task).toContain("MARKER-INTENT");
  });

  test("writes the review block into the PR body, replacing only that region on re-run", async () => {
    const agent = new FakeHarness();
    agent.responses.push(...cleanPasses());
    const forge = new FakeForge();
    const body = "Human prose.\n\n<!-- tml:review -->stale<!-- /tml:review -->\n\nMore prose.";
    forge.bodyValue = body;
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith(body) },
    });

    await reviewStep().run(ctx);

    expect(forge.bodyUpdates).toHaveLength(1);
    const updated = forge.bodyUpdates[0]?.body ?? "";
    expect(updated).toContain("Human prose."); // human prose preserved
    expect(updated).toContain("More prose.");
    expect(updated).not.toContain("stale"); // the old block is gone
    expect(updated).toContain("<!-- tml:review -->");
    expect(updated).toContain("**Risk: low**");
    // the block appears exactly once (not duplicated)
    expect(updated.match(/<!-- tml:review -->/g)).toHaveLength(1);
  });

  test("appends a fresh block when the body has none yet", async () => {
    const agent = new FakeHarness();
    agent.responses.push(...cleanPasses());
    const forge = new FakeForge();
    forge.bodyValue = "Just the description.";
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("Just the description.") },
    });

    await reviewStep().run(ctx);

    const updated = forge.bodyUpdates[0]?.body ?? "";
    expect(updated.startsWith("Just the description.")).toBe(true);
    expect(updated).toContain("<!-- tml:review -->");
  });

  test("preserves PR body edits made after the open-pr snapshot", async () => {
    const agent = new FakeHarness();
    agent.responses.push(...cleanPasses());
    const forge = new FakeForge();
    forge.bodyValue = "Human edit after open-pr.";
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("Original open-pr body.") },
    });

    await reviewStep().run(ctx);

    const updated = forge.bodyUpdates[0]?.body ?? "";
    expect(updated).toContain("Human edit after open-pr.");
    expect(updated).not.toContain("Original open-pr body.");
    expect(updated).toContain("<!-- tml:review -->");
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
    const { ctx, asks } = fakeCtx({
      agent,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

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
    const { ctx } = fakeCtx({ agent, reads: { prBody: "body", pullRequest: prWith("body") } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(agent.tasks).toHaveLength(6);
    expect(agent.opts[5]?.schema).toBeUndefined(); // the fix pass requests no schema
    expect(summary).toContain("fixed the off-by-one");
  });

  test("failed fix pass aborts before marking auto-fix findings fixed", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([
        { severity: "warning", action: "auto-fix", title: "Off-by-one", detail: "loop overruns" },
      ]),
      pass([]),
      pass([]),
      { ok: false, summary: "could not fix safely" },
    );
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    let caught: unknown;
    try {
      await reviewStep().run(ctx);
    } catch (err) {
      caught = err;
    }

    expect((caught as Error | undefined)?.message).toContain("could not fix safely");
    expect(forge.bodyUpdates).toHaveLength(0);
    expect(forge.reviews).toHaveLength(0);
  });

  test("posts a located ask-user finding as a marked thread, counts it, and never lists it", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([
        {
          severity: "warning",
          action: "ask-user",
          title: "Confirm contract",
          detail: "intent?",
          location: "src/a.ts:12",
        },
      ]),
      pass([]),
      pass([]),
    );
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(agent.tasks).toHaveLength(5); // no fix pass ran
    expect(forge.createdThreads).toHaveLength(1);
    expect(forge.createdThreads[0]?.path).toBe("src/a.ts");
    expect(forge.createdThreads[0]?.line).toBe(12);
    expect(forge.createdThreads[0]?.body).toContain("tml:finding");
    expect(forge.createdThreads[0]?.commitSha).toBe("headsha");
    expect(summary).toContain("thread needs your decision"); // counted in the headline tally
    expect(summary).not.toContain("Confirm contract"); // not listed — it lives as the thread
  });

  test("keeps an ask-user finding with no path:line location in the summary", async () => {
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
    const forge = new FakeForge();
    const { ctx, logs } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(forge.createdThreads).toHaveLength(0);
    expect(summary).toContain("1 finding needs your decision");
    expect(summary).toContain("Confirm contract");
    expect(summary).toContain("intent?");
    expect(logs.some((l) => l.includes("no path:line"))).toBe(true);
  });

  test("never re-posts a finding that already has a thread (open or resolved)", async () => {
    const agent = new FakeHarness();
    const finding = {
      severity: "warning" as const,
      action: "ask-user" as const,
      title: "Confirm contract",
      detail: "intent?",
      location: "src/a.ts:12",
    };
    agent.responses.push(
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([finding]),
      pass([]),
      pass([]),
    );
    const forge = new FakeForge();
    // The PR already carries a resolved tml thread for this very finding.
    const key = findingKey(finding);
    const pr = prWith("body");
    pr.threads.push({
      id: "RT_old",
      body: findingMarker(key),
      resolved: true,
      comments: [
        {
          author: "tml",
          body: findingMarker(key),
          reactions: { thumbsUp: 0, thumbsDown: 0 },
          isMine: true,
        },
      ],
    });
    const { ctx } = fakeCtx({ agent, forge, reads: { prBody: "body", pullRequest: pr } });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(forge.createdThreads).toHaveLength(0); // deduped — never re-post a settled finding
    expect(summary).not.toContain("thread needs your decision"); // the existing one is resolved
  });

  test("a thread that fails to post is logged, not fatal; the review still completes", async () => {
    const agent = new FakeHarness();
    agent.responses.push(
      pass([]),
      pass([], { verdict: "proceed" }),
      pass([
        {
          severity: "warning",
          action: "ask-user",
          title: "Confirm contract",
          detail: "intent?",
          location: "src/a.ts:12",
        },
      ]),
      pass([]),
      pass([]),
    );
    class ThrowingForge extends FakeForge {
      override createReviewThread() {
        return Promise.reject(new Error("422 line not in diff"));
      }
    }
    const forge = new ThrowingForge();
    const { ctx, logs } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    const summary = summaryOf(await reviewStep().run(ctx));

    expect(forge.bodyUpdates).toHaveLength(1); // the run still wrote the block
    expect(forge.reviews).toHaveLength(1); // and advanced the resume marker
    expect(summary).toContain("1 finding needs your decision");
    expect(summary).toContain("Confirm contract");
    expect(logs.some((l) => l.includes("could not post a thread"))).toBe(true);
  });

  test("delta gate: runs zero passes and leaves the existing block untouched when already reviewed", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    forge.lastReviewedShaValue = "headsha"; // == prWith().headSha
    const { ctx, logs } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("Description.") },
    });

    await reviewStep().run(ctx);

    expect(agent.tasks).toHaveLength(0); // no passes, no fix pass
    expect(forge.createdThreads).toHaveLength(0);
    expect(forge.reviews).toHaveLength(0); // the resume marker is not re-advanced
    expect(forge.bodyUpdates).toHaveLength(0); // the prior block is preserved, not rewritten
    expect(logs.some((l) => l.includes("no new commits"))).toBe(true);
  });

  test("propagates pass results that are not schema-valid", async () => {
    const agent = new FakeHarness();
    agent.responses.push(pass([], { understanding: "intent" }), pass([], { verdict: "proceed" }), {
      ok: true,
      summary: "broke",
      output: "not a structured pass result",
    });
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    let caught: unknown;
    try {
      await reviewStep().run(ctx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("structured pass result");
    expect(forge.bodyUpdates).toHaveLength(0);
    expect(forge.reviews).toHaveLength(0);
  });

  test("propagates failed review pass results", async () => {
    const agent = new FakeHarness();
    agent.responses.push({
      ok: false,
      summary: "schema extraction failed",
      output: { findings: [] },
    });
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    let caught: unknown;
    try {
      await reviewStep().run(ctx);
    } catch (err) {
      caught = err;
    }

    expect((caught as Error | undefined)?.message).toContain("schema extraction failed");
    expect(forge.bodyUpdates).toHaveLength(0);
    expect(forge.reviews).toHaveLength(0);
  });

  test("propagates agent structured-output failures from review passes", async () => {
    class ThrowingHarness extends FakeHarness {
      override run() {
        return Promise.reject(new Error("no schema-valid JSON object found in agent output"));
      }
    }
    const agent = new ThrowingHarness();
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    let caught: unknown;
    try {
      await reviewStep().run(ctx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("no schema-valid JSON object");
    expect(forge.bodyUpdates).toHaveLength(0);
    expect(forge.reviews).toHaveLength(0);
  });

  test("advances the resume marker via submitReview tied to the head", async () => {
    const agent = new FakeHarness();
    agent.responses.push(...cleanPasses());
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    await reviewStep().run(ctx);

    expect(forge.reviews).toHaveLength(1);
    expect(forge.reviews[0]?.commitSha).toBe("headsha");
  });

  test("reverts and warns when a read-only pass modifies the worktree", async () => {
    // The worktree is clean when review starts but dirty once the passes have run — i.e. a
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
    agent.responses.push(...cleanPasses());
    const { ctx, logs } = fakeCtx({
      agent,
      git,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    await reviewStep().run(ctx);

    expect(git.calls).toContain("discardChanges");
    expect(logs.some((l) => l.toLowerCase().includes("modified the worktree"))).toBe(true);
  });

  test("does not revert when the read-only passes leave the worktree untouched", async () => {
    const git = new FakeGit(); // status stays clean across both checks
    const agent = new FakeHarness();
    agent.responses.push(...cleanPasses());
    const { ctx } = fakeCtx({
      agent,
      git,
      reads: { prBody: "body", pullRequest: prWith("body") },
    });

    await reviewStep().run(ctx);

    expect(git.calls).not.toContain("discardChanges");
  });
});
