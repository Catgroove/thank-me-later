import { describe, expect, test } from "bun:test";
import type { AgentResult, PullRequest, Reactions, ReviewComment, ReviewThread } from "@tml/core";
import { respondCommentsStep } from "../src/steps/respond-comments.ts";
import { findingMarker, handoffReply, tmlReply } from "../src/review/threads.ts";
import { FakeForge, FakeHarness, fakeCtx } from "./fake-ctx.ts";

const NONE: Reactions = { thumbsUp: 0, thumbsDown: 0 };

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return { author: "human", body: "comment", reactions: NONE, ...over };
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return { id: "RT", body: "", resolved: false, comments: [], ...over };
}

/** A tml finding thread (root carries the marker), with the given reactions on its root. */
function tmlThread(id: string, reactions: Reactions, extra: ReviewComment[] = []): ReviewThread {
  const root = comment({ author: "tml", body: `${findingMarker("k1")} please confirm`, reactions });
  return thread({ id, body: root.body, comments: [root, ...extra] });
}

function prWithThreads(threads: ReviewThread[]): PullRequest {
  return {
    number: 5,
    url: "https://forge.test/pr/5",
    head: "feat/x",
    base: "main",
    title: "t",
    body: "b",
    state: "open",
    mergeable: "mergeable",
    reviewDecision: null,
    headSha: "headsha",
    checks: [],
    threads,
  };
}

const reply = (out: { status?: string; note?: string; reply?: string }): AgentResult => ({
  ok: true,
  summary: "done",
  output: out,
});

describe("respond-comments step", () => {
  test("👍 on a tml thread → apply the fix and resolve", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { pullRequest: prWithThreads([tmlThread("RT1", { thumbsUp: 1, thumbsDown: 0 })]) },
    });

    await respondCommentsStep().run(ctx);

    expect(agent.tasks).toHaveLength(1); // the fix pass
    expect(agent.opts[0]?.schema).toBeUndefined(); // fix needs no schema
    expect(forge.resolved).toEqual(["RT1"]);
    expect(forge.replies).toHaveLength(0);
  });

  test("👎 on a tml thread → resolve without changing anything", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { pullRequest: prWithThreads([tmlThread("RT1", { thumbsUp: 0, thumbsDown: 1 })]) },
    });

    await respondCommentsStep().run(ctx);

    expect(agent.tasks).toHaveLength(0); // no agent — dismiss is code-only
    expect(forge.resolved).toEqual(["RT1"]);
  });

  test("a reply on a tml thread → interpret, reply, and resolve when done", async () => {
    const agent = new FakeHarness();
    agent.responses.push(reply({ status: "resolved", note: "applied your suggestion" }));
    const forge = new FakeForge();
    const t = tmlThread("RT1", NONE, [comment({ author: "human", body: "use a Map here" })]);
    const { ctx } = fakeCtx({ agent, forge, reads: { pullRequest: prWithThreads([t]) } });

    await respondCommentsStep().run(ctx);

    expect(agent.opts[0]?.schema).toBeDefined(); // interpret uses a schema
    expect(forge.replies[0]?.body).toContain("applied your suggestion");
    expect(forge.resolved).toEqual(["RT1"]);
  });

  test("a reply outweighs a reaction when both are present (interprets, not blind-fix)", async () => {
    const agent = new FakeHarness();
    agent.responses.push(reply({ status: "resolved", note: "done" }));
    const forge = new FakeForge();
    // thumbs-up AND a human reply: the reply path wins.
    const t = tmlThread("RT1", { thumbsUp: 1, thumbsDown: 0 }, [
      comment({ author: "human", body: "actually, do it this other way" }),
    ]);
    const { ctx } = fakeCtx({ agent, forge, reads: { pullRequest: prWithThreads([t]) } });

    await respondCommentsStep().run(ctx);

    expect(agent.opts[0]?.schema).toBeDefined(); // interpret path, not the schema-less fix path
    expect(forge.replies).toHaveLength(1); // a reply is posted (fix path posts none)
    expect(forge.resolved).toEqual(["RT1"]);
  });

  test("an insufficient reply → reply but leave the thread open", async () => {
    const agent = new FakeHarness();
    agent.responses.push(reply({ status: "insufficient", note: "which file did you mean?" }));
    const forge = new FakeForge();
    const t = tmlThread("RT1", NONE, [comment({ author: "human", body: "fix it" })]);
    const { ctx } = fakeCtx({ agent, forge, reads: { pullRequest: prWithThreads([t]) } });

    await respondCommentsStep().run(ctx);

    expect(forge.replies[0]?.body).toContain("which file did you mean?");
    expect(forge.resolved).toHaveLength(0); // left open
  });

  test("a tml reply after the last human reply → leave the thread parked on re-entry", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const t = tmlThread("RT1", NONE, [
      comment({ author: "human", body: "fix it" }),
      comment({ author: "tml", body: tmlReply("which file did you mean?") }),
    ]);
    const { ctx } = fakeCtx({ agent, forge, reads: { pullRequest: prWithThreads([t]) } });

    await respondCommentsStep().run(ctx);

    expect(agent.tasks).toHaveLength(0);
    expect(forge.replies).toHaveLength(0);
    expect(forge.resolved).toHaveLength(0);
  });

  test("no signal on a tml thread → leave it parked (no reply, no resolve)", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { pullRequest: prWithThreads([tmlThread("RT1", NONE)]) },
    });

    await respondCommentsStep().run(ctx);

    expect(agent.tasks).toHaveLength(0);
    expect(forge.replies).toHaveLength(0);
    expect(forge.resolved).toHaveLength(0);
  });

  test("a human's thread → reply and leave it open (never resolved)", async () => {
    const agent = new FakeHarness();
    agent.responses.push(reply({ reply: "good catch — fixed in this push" }));
    const forge = new FakeForge();
    const human = thread({
      id: "RT_human",
      body: "please rename this",
      comments: [comment({ author: "reviewer", body: "please rename this" })],
    });
    const { ctx } = fakeCtx({ agent, forge, reads: { pullRequest: prWithThreads([human]) } });

    await respondCommentsStep().run(ctx);

    expect(agent.tasks).toHaveLength(1);
    expect(forge.replies[0]?.body).toContain("good catch");
    expect(forge.resolved).toHaveLength(0); // tml never resolves a thread it didn't open
  });

  test("a human's thread with tml as the latest commenter → wait for a new human reply", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const human = thread({
      id: "RT_human",
      body: "please rename this",
      comments: [
        comment({ author: "reviewer", body: "please rename this" }),
        comment({ author: "tml", body: tmlReply("renamed in this push") }),
      ],
    });
    const { ctx } = fakeCtx({ agent, forge, reads: { pullRequest: prWithThreads([human]) } });

    await respondCommentsStep().run(ctx);

    expect(agent.tasks).toHaveLength(0);
    expect(forge.replies).toHaveLength(0);
    expect(forge.resolved).toHaveLength(0);
  });

  test("ping-pong guard: ≥3 tml comments → hand off and leave open, no agent", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const churned = thread({
      id: "RT_loop",
      body: "human topic",
      comments: [
        comment({ author: "reviewer", body: "human topic" }),
        comment({ author: "tml", body: tmlReply("one") }),
        comment({ author: "tml", body: tmlReply("two") }),
        comment({ author: "tml", body: tmlReply("three") }),
      ],
    });
    const { ctx } = fakeCtx({ agent, forge, reads: { pullRequest: prWithThreads([churned]) } });

    await respondCommentsStep().run(ctx);

    expect(agent.tasks).toHaveLength(0);
    expect(forge.replies[0]?.body).toContain("handing it to a human");
    expect(forge.resolved).toHaveLength(0);
  });

  test("a thread already handed off is left untouched on re-entry (no duplicate handoff)", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const alreadyHandedOff = thread({
      id: "RT_loop",
      body: "human topic",
      comments: [
        comment({ author: "reviewer", body: "human topic" }),
        comment({ author: "tml", body: tmlReply("one") }),
        comment({ author: "tml", body: tmlReply("two") }),
        comment({ author: "tml", body: handoffReply() }),
      ],
    });
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { pullRequest: prWithThreads([alreadyHandedOff]) },
    });

    await respondCommentsStep().run(ctx);

    expect(forge.replies).toHaveLength(0); // no second handoff
    expect(agent.tasks).toHaveLength(0);
    expect(forge.resolved).toHaveLength(0);
  });

  test("only the starting snapshot of unresolved threads is processed", async () => {
    const agent = new FakeHarness();
    const forge = new FakeForge();
    const resolved = thread({ id: "RT_done", resolved: true, body: findingMarker("k9") });
    const open = tmlThread("RT1", { thumbsUp: 0, thumbsDown: 1 });
    const { ctx } = fakeCtx({
      agent,
      forge,
      reads: { pullRequest: prWithThreads([resolved, open]) },
    });

    await respondCommentsStep().run(ctx);

    expect(forge.resolved).toEqual(["RT1"]); // the already-resolved thread is left alone
  });
});
