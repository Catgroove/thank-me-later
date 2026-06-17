// `review` — a review of the PR's diff that mimics how a staff engineer reads a change: five
// focused read-only passes (context → architecture → correctness → design+NFR → micro), then one
// fix pass that applies the safe fixes the passes surfaced. Read-only is the passes' contract; the
// prompts ask for it and a before/after worktree check reverts any edits a pass makes anyway, so
// only the fix pass can change files. Synthesis and the overall risk are computed in code (see
// `../review/synthesize.ts`), not by the agent. The architecture pass can `block`, which is
// recorded as a high-risk banner — it does not halt the run.
//
// `review` runs *after* `open-pr`, against the live PR:
//   - Delta gate: if the PR head matches the last SHA tml reviewed, it runs zero passes — there's
//     nothing new to review — and only refreshes the body block.
//   - `ask-user` findings become resolvable, line-anchored review threads, each stamped with a
//     `tml:finding` marker and skipped on re-runs if a thread already exists (open or resolved).
//   - It writes its headline + dashboard into a delimited `tml:review` block on the PR body
//     (replacing only that region) and submits a COMMENT review tied to the head — the resume
//     marker the delta gate reads next time. The same markdown is the `reviewSummary` artifact.

import { type Ctx, defineStep, type Git, type GitStatus, type Harness, type Step } from "@tml/core";
import { prBody, pullRequest, reviewSummary } from "../artifacts.ts";
import {
  architecturePrompt,
  architectureSchema,
  contextPrompt,
  correctnessPrompt,
  designPrompt,
  findingsSchema,
  fixPrompt,
  microPrompt,
} from "../prompts.ts";
import {
  type PassResult,
  type ReviewPass,
  parsePassResult,
  replaceReviewBlock,
  reviewBlock,
  summarize,
} from "../review/synthesize.ts";
import {
  existingKeys,
  findingKey,
  findingThreadBody,
  isTmlThread,
  parseLocation,
} from "../review/threads.ts";

/** Run one read-only review pass: structured reply against the given schema, validated. */
async function runPass(
  agent: Harness,
  prompt: string,
  schema: object = findingsSchema,
): Promise<PassResult> {
  const result = await agent.run(prompt, { schema });
  return parsePassResult(result.output);
}

/** The set of files git reports as changed (staged or unstaged), for before/after comparison. */
function touched(status: GitStatus): string {
  return [...status.staged, ...status.unstaged].sort().join("\n");
}

/** Read-only is prompt-enforced, not sandboxed: the passes call the same edit-capable Harness.
 *  This guard makes read-only a real invariant — if a pass modified the worktree despite the
 *  prompt, those edits are reverted so they can't be misattributed to the fix pass and committed
 *  by the trailing commit(review). The pipeline commits all prior work before review runs, so the
 *  worktree is clean here and reverting to HEAD discards exactly the rogue edits. */
async function revertRogueEdits(
  git: Git,
  before: GitStatus,
  log: (m: string) => void,
): Promise<void> {
  if (touched(await git.status()) === touched(before)) return;
  log("warning: a read-only review pass modified the worktree; reverting before the fix pass");
  await git.discardChanges();
}

/** The five passes + the fix pass; the read-only contract is enforced around them. */
async function runReview(
  ctx: Ctx,
  prBodyText: string,
): Promise<{ passes: ReviewPass[]; fixSummary: string }> {
  const { agent } = ctx;
  const before = await ctx.git.status();
  const context = await runPass(agent, contextPrompt(prBodyText));
  const understanding = context.understanding ?? "";
  const architecture = await runPass(agent, architecturePrompt(understanding), architectureSchema);
  const correctness = await runPass(agent, correctnessPrompt(understanding));
  const design = await runPass(agent, designPrompt(understanding));
  const micro = await runPass(agent, microPrompt(understanding));
  await revertRogueEdits(ctx.git, before, (m) => ctx.log(m));

  const passes: ReviewPass[] = [
    { title: "Context & intent", result: context },
    { title: "Architecture & scope", result: architecture },
    { title: "Correctness & testing", result: correctness },
    { title: "Design & non-functional", result: design },
    { title: "Maintainability & nits", result: micro },
  ];

  // Only safe, non-behavioural findings are auto-fixed; ask-user findings become threads. Skip the
  // fix pass (and its agent call) when there's nothing to fix.
  const fixable = passes.flatMap((p) => p.result.findings).filter((f) => f.action === "auto-fix");
  const fixSummary = fixable.length > 0 ? (await agent.run(fixPrompt(fixable))).summary : "";
  return { passes, fixSummary };
}

export function reviewStep(): Step {
  return defineStep({
    name: "review",
    consumes: [prBody, pullRequest],
    produces: [reviewSummary],
    async run(ctx) {
      const pr = ctx.read(pullRequest);

      // Delta gate: nothing new on the head since the last review tml submitted → run no passes.
      const lastReviewed = await ctx.forge.lastReviewedSha(pr.number);
      const delta = pr.headSha !== lastReviewed;

      let passes: ReviewPass[] = [];
      let fixSummary = "";
      let posted = 0;
      if (delta) {
        ({ passes, fixSummary } = await runReview(ctx, ctx.read(prBody)));

        // Post each ask-user finding as a marked, line-anchored thread — skipping any whose key
        // already has a thread (open or resolved), so a settled finding is never re-posted.
        const seen = existingKeys(pr.threads);
        const askUser = passes
          .flatMap((p) => p.result.findings)
          .filter((f) => f.action === "ask-user");
        for (const f of askUser) {
          const key = findingKey(f);
          if (seen.has(key)) continue;
          const loc = parseLocation(f.location);
          if (loc === null) {
            ctx.log(`review: "${f.title}" has no path:line location — skipping its thread`);
            continue;
          }
          seen.add(key);
          await ctx.forge.createReviewThread({
            prNumber: pr.number,
            path: loc.path,
            line: loc.line,
            body: findingThreadBody(f),
            commitSha: pr.headSha,
          });
          posted += 1;
        }
      } else {
        ctx.log("review: no new commits since the last review — skipping the passes");
      }

      // The "needs your decision" tally points at the unresolved tml threads now on the PR:
      // the ones that were already open plus the ones just posted.
      const stillOpen = pr.threads.filter((t) => !t.resolved && isTmlThread(t)).length;
      const openThreads = stillOpen + posted;

      const summary = summarize(passes, fixSummary, openThreads);
      const body = replaceReviewBlock(pr.body, reviewBlock(summary));
      await ctx.forge.updatePullRequestBody({ prNumber: pr.number, body });

      // Advance the resume marker only when we actually reviewed the current head.
      if (delta) {
        await ctx.forge.submitReview({ prNumber: pr.number, commitSha: pr.headSha, body: summary });
      }

      return { reviewSummary: summary };
    },
  });
}
