// `respond-comments` — the resolver loop. It reconciles the PR's unresolved review threads as of
// the start of the run (the snapshot `open-pr` produced; no mid-run re-read), driving each toward a
// fix, a justification, an acknowledgement, or a hand-off:
//
//   - tml's own finding thread (carries the `tml:finding` marker):
//       👍 on the root → apply the proposed change, resolve.
//       👎 on the root → resolve (dismiss; no change).
//       a reply        → interpret + act; resolve when done, else reply and leave open.
//       no signal      → leave parked.
//     A reply outweighs a reaction when both are present.
//   - a human's / another bot's thread (no marker): classify the latest comment, reply, and leave
//     it open — tml never resolves a thread it didn't open.
//   - ping-pong guard: once a thread holds ≥ 3 tml-authored comments, post one hand-off reply and
//     leave it open, untouched on future re-entries.
//
// Any fixes made here are committed by the trailing commit group and pushed by `push`. The step
// itself only edits files + talks to the Forge; it produces a short `respondSummary`.

import { type Ctx, defineStep, type ReviewThread, type Step } from "@tml/core";
import { pullRequest, respondSummary } from "../artifacts.ts";
import {
  classifyThreadPrompt,
  humanReplySchema,
  interpretReplyPrompt,
  replyActionSchema,
  respondFixPrompt,
} from "../prompts.ts";
import {
  handoffReply,
  isHandedOff,
  isTmlThread,
  tmlReply,
  tmlRoundCount,
  tmlThreadAction,
} from "../review/threads.ts";

/** Max tml turns on a single thread before handing it to a human. */
const PING_PONG_CEILING = 3;

function parseReplyAction(output: unknown): { status: "resolved" | "insufficient"; note: string } {
  const o = (output ?? {}) as Record<string, unknown>;
  const status = o.status === "resolved" ? "resolved" : "insufficient";
  const note = typeof o.note === "string" ? o.note : "";
  return { status, note };
}

function parseHumanReply(output: unknown): string {
  const o = (output ?? {}) as Record<string, unknown>;
  return typeof o.reply === "string" ? o.reply : "";
}

/** Reconcile one of tml's own finding threads; returns a one-line action summary. */
async function respondToTmlThread(ctx: Ctx, t: ReviewThread): Promise<string> {
  const threadId = t.id;
  const action = tmlThreadAction(t);
  if (action === "fix") {
    await ctx.agent.run(respondFixPrompt(t));
    await ctx.forge.resolveThread(threadId);
    return `fixed + resolved ${threadId}`;
  }
  if (action === "dismiss") {
    await ctx.forge.resolveThread(threadId);
    return `dismissed ${threadId}`;
  }
  if (action === "interpret-reply") {
    const res = await ctx.agent.run(interpretReplyPrompt(t), { schema: replyActionSchema });
    const { status, note } = parseReplyAction(res.output);
    await ctx.forge.replyToThread({ threadId, body: tmlReply(note) });
    if (status === "resolved") {
      await ctx.forge.resolveThread(threadId);
      return `addressed reply + resolved ${threadId}`;
    }
    return `replied (need more) on ${threadId}`;
  }
  return `left ${threadId} parked`;
}

export function respondCommentsStep(): Step {
  return defineStep({
    name: "respond-comments",
    consumes: [pullRequest],
    produces: [respondSummary],
    async run(ctx) {
      const pr = ctx.read(pullRequest);
      const unresolved = pr.threads.filter((t) => !t.resolved); // the starting snapshot only
      const actions: string[] = [];

      for (const t of unresolved) {
        // Ping-pong guard: stop engaging a thread that has churned without converging. Post the
        // hand-off once, then leave it untouched on every later re-entry.
        if (tmlRoundCount(t) >= PING_PONG_CEILING) {
          if (!isHandedOff(t)) {
            await ctx.forge.replyToThread({ threadId: t.id, body: handoffReply() });
            actions.push(`handed ${t.id} to a human`);
          }
          continue;
        }

        if (isTmlThread(t)) {
          actions.push(await respondToTmlThread(ctx, t));
        } else {
          // A thread tml didn't open: reply and leave it open — never resolve it.
          const res = await ctx.agent.run(classifyThreadPrompt(t), { schema: humanReplySchema });
          await ctx.forge.replyToThread({
            threadId: t.id,
            body: tmlReply(parseHumanReply(res.output)),
          });
          actions.push(`replied on ${t.id} (left open)`);
        }
      }

      const summary = actions.length > 0 ? actions.join("; ") : "no unresolved threads";
      ctx.log(`respond-comments: ${summary}`);
      return { respondSummary: summary };
    },
  });
}
