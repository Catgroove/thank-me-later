import { describe, expect, test } from "bun:test";
import type { CheckRun, PullRequest, ReviewThread } from "@tml/core";
import type { MergeReadiness } from "../src/artifacts.ts";
import { mergeGateStep } from "../src/steps/merge-gate.ts";
import { FakeForge, fakeCtx } from "./fake-ctx.ts";

const greenCheck: CheckRun = { name: "ci", status: "completed", conclusion: "success" };

function resolvedThread(id: string): ReviewThread {
  return { id, body: "x", resolved: true, comments: [] };
}
function openThread(id: string): ReviewThread {
  return { id, body: "x", resolved: false, comments: [] };
}

/** A FakeForge whose `getPullRequest` snapshot is configured for the gate. */
function gateForge(over: Partial<PullRequest> = {}): FakeForge {
  const forge = new FakeForge();
  forge.checks = over.checks ?? [greenCheck];
  forge.threads = over.threads ?? [];
  forge.reviewDecision = over.reviewDecision ?? null;
  forge.mergeable = over.mergeable ?? "mergeable";
  return forge;
}

const reads = (number = 5) => ({
  pullRequest: {
    number,
    url: "u",
    head: "h",
    base: "main",
    title: "t",
    body: "b",
    state: "open" as const,
    mergeable: "mergeable" as const,
    reviewDecision: null,
    headSha: "headsha",
    checks: [],
    threads: [],
  },
});

function readinessOf(result: unknown): MergeReadiness {
  return (result as { mergeReadiness: MergeReadiness }).mergeReadiness;
}

describe("merge-gate step", () => {
  test("ready when all four conditions hold", async () => {
    const forge = gateForge({ threads: [resolvedThread("RT1")], mergeable: "mergeable" });
    const { ctx } = fakeCtx({ forge, reads: reads() });

    const r = readinessOf(await mergeGateStep().run(ctx));

    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  test("blocks on failing checks", async () => {
    const forge = gateForge({
      checks: [{ name: "test", status: "completed", conclusion: "failure" }],
    });
    const { ctx } = fakeCtx({ forge, reads: reads() });

    const r = readinessOf(await mergeGateStep().run(ctx));

    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes("test"))).toBe(true);
  });

  test("blocks on a changes-requested review", async () => {
    const forge = gateForge({ reviewDecision: "changes_requested" });
    const { ctx } = fakeCtx({ forge, reads: reads() });

    const r = readinessOf(await mergeGateStep().run(ctx));

    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("changes requested");
  });

  test("blocks when review is required", async () => {
    const forge = gateForge({ reviewDecision: "review_required" });
    const { ctx } = fakeCtx({ forge, reads: reads() });

    const r = readinessOf(await mergeGateStep().run(ctx));

    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("review required");
  });

  test("blocks on unresolved threads", async () => {
    const forge = gateForge({ threads: [resolvedThread("RT1"), openThread("RT2")] });
    const { ctx } = fakeCtx({ forge, reads: reads() });

    const r = readinessOf(await mergeGateStep().run(ctx));

    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("1 unresolved thread");
  });

  test("treats mergeable=unknown as not-ready (conservative)", async () => {
    const forge = gateForge({ mergeable: "unknown" });
    const { ctx } = fakeCtx({ forge, reads: reads() });

    const r = readinessOf(await mergeGateStep().run(ctx));

    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("mergeable: unknown");
  });

  test("lists every blocker at once and never merges (there is no merge op)", async () => {
    const forge = gateForge({
      checks: [{ name: "build", status: "completed", conclusion: "failure" }],
      reviewDecision: "review_required",
      threads: [openThread("RT2")],
      mergeable: "conflicted",
    });
    const { ctx } = fakeCtx({ forge, reads: reads() });

    const r = readinessOf(await mergeGateStep().run(ctx));

    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("review required");
    expect(r.blockers).toHaveLength(4);
    // The Forge exposes no merge method — the gate cannot merge by construction.
    expect("merge" in forge).toBe(false);
    expect("mergePullRequest" in forge).toBe(false);
  });
});
