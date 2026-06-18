// Integration-style: the post-PR re-entry path. With an open PR carrying acked tml threads and no
// new commits, `review` no-ops via the delta gate, `respond-comments` drives the threads to
// resolution, and `merge-gate` reaches "ready". Drives the three steps in sequence against one
// stateful FakeForge, re-reading the snapshot between steps as the engine would.

import { describe, expect, test } from "bun:test";
import type { Reactions, ReviewComment, ReviewThread } from "@tml/core";
import type { MergeReadiness } from "../src/artifacts.ts";
import { mergeGateStep } from "../src/steps/merge-gate.ts";
import { respondCommentsStep } from "../src/steps/respond-comments.ts";
import { reviewStep } from "../src/steps/review.ts";
import { findingMarker } from "../src/review/threads.ts";
import { FakeForge, FakeHarness, fakeCtx } from "./fake-ctx.ts";

function tmlThread(id: string, key: string, reactions: Reactions): ReviewThread {
  const root: ReviewComment = {
    author: "tml",
    body: `${findingMarker(key)} please confirm`,
    reactions,
    isMine: true,
  };
  return { id, body: root.body, resolved: false, comments: [root] };
}

describe("re-entry: review (delta no-op) → respond-comments → merge-gate", () => {
  test("acked threads drive to resolution and the gate reports ready", async () => {
    const forge = new FakeForge();
    forge.headShaValue = "sha1";
    forge.lastReviewedShaValue = "sha1"; // nothing new since the last review → delta gate skips passes
    forge.checks = [{ name: "ci", status: "completed", conclusion: "success" }];
    forge.threads = [
      tmlThread("RT_up", "k1", { thumbsUp: 1, thumbsDown: 0 }), // 👍 → fix + resolve
      tmlThread("RT_down", "k2", { thumbsUp: 0, thumbsDown: 1 }), // 👎 → dismiss + resolve
    ];

    const agent = new FakeHarness();

    // review — re-read the snapshot, run the step
    const prForReview = await forge.getPullRequest(5);
    await reviewStep().run(
      fakeCtx({ forge, agent, reads: { prBody: "body", pullRequest: prForReview } }).ctx,
    );
    expect(agent.tasks).toHaveLength(0); // delta gate: zero passes
    expect(forge.createdThreads).toHaveLength(0); // nothing new to post

    // respond-comments — reconcile the acked threads
    const prForRespond = await forge.getPullRequest(5);
    await respondCommentsStep().run(
      fakeCtx({ forge, agent, reads: { pullRequest: prForRespond } }).ctx,
    );
    expect(new Set(forge.resolved)).toEqual(new Set(["RT_up", "RT_down"]));

    // merge-gate — fresh snapshot now shows every thread resolved
    const prForGate = await forge.getPullRequest(5);
    const result = await mergeGateStep().run(
      fakeCtx({ forge, reads: { pullRequest: prForGate } }).ctx,
    );
    const readiness = (result as { mergeReadiness: MergeReadiness }).mergeReadiness;

    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
  });

  test("an unresolved human thread keeps the gate closed", async () => {
    const forge = new FakeForge();
    forge.headShaValue = "sha1";
    forge.lastReviewedShaValue = "sha1";
    forge.threads = [
      {
        id: "RT_human",
        body: "please rename",
        resolved: false,
        comments: [
          { author: "reviewer", body: "please rename", reactions: { thumbsUp: 0, thumbsDown: 0 } },
        ],
      },
    ];
    const agent = new FakeHarness();
    agent.responses.push({ ok: true, summary: "done", output: { reply: "renamed in this push" } });

    const prForRespond = await forge.getPullRequest(5);
    await respondCommentsStep().run(
      fakeCtx({ forge, agent, reads: { pullRequest: prForRespond } }).ctx,
    );
    expect(forge.resolved).toHaveLength(0); // tml never resolves a thread it didn't open

    const prForGate = await forge.getPullRequest(5);
    const result = await mergeGateStep().run(
      fakeCtx({ forge, reads: { pullRequest: prForGate } }).ctx,
    );
    const readiness = (result as { mergeReadiness: MergeReadiness }).mergeReadiness;

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toContain("1 unresolved thread");
  });
});
