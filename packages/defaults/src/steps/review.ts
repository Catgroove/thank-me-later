// `review` - a pre-push review of the branch's diff that mimics how a staff engineer reads a
// change: five focused read-only passes (context → architecture → correctness → design+NFR →
// micro), then one fix pass that applies the safe fixes the passes surfaced. Read-only is the
// passes' contract; the prompts ask for it and a before/after worktree check reverts any edits a
// pass makes anyway, so only the fix pass can change files. Synthesis and the
// overall risk are computed in code (see `../review/synthesize.ts`), not by the agent. The
// architecture pass can `block`, which is recorded as a high-risk banner - it does not halt the
// run. The resulting markdown becomes the `reviewSummary` artifact `open-pr` folds into the PR
// body.

import { defineStep, type Git, type GitStatus, type Harness, type Step } from "@tml/core";
import { prBody, reviewSummary } from "../artifacts.ts";
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
  summarize,
} from "../review/synthesize.ts";

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
 *  This guard makes read-only a real invariant - if a pass modified the worktree despite the
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

export function reviewStep(): Step {
  return defineStep({
    name: "review",
    consumes: [prBody],
    produces: [reviewSummary],
    async run(ctx) {
      const { agent } = ctx;
      const before = await ctx.git.status();
      const context = await runPass(agent, contextPrompt(ctx.read(prBody)));
      const understanding = context.understanding ?? "";
      const architecture = await runPass(
        agent,
        architecturePrompt(understanding),
        architectureSchema,
      );
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

      // Only safe, non-behavioural findings are auto-fixed; ask-user findings go to the human
      // via the summary. Skip the fix pass (and its agent call) when there's nothing to fix.
      const fixable = passes
        .flatMap((p) => p.result.findings)
        .filter((f) => f.action === "auto-fix");
      const fixSummary = fixable.length > 0 ? (await agent.run(fixPrompt(fixable))).summary : "";

      return {
        artifacts: { reviewSummary: summarize(passes, fixSummary) },
        rounds: [
          {
            trigger: "initial",
            findings: passes.flatMap((p) => p.result.findings),
            selectedFindingIds: fixable.map((f) => f.id),
            ...(fixSummary.trim().length > 0 ? { fixSummary: fixSummary.trim() } : {}),
          },
        ],
      };
    },
  });
}
