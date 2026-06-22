// `review` - a pre-push review of the branch's diff that mimics how a staff engineer reads a
// change: five focused read-only passes (context -> architecture -> correctness -> design+NFR ->
// micro), then a core round loop applies safe fixes and verifies them with fresh passes. Read-only
// is the passes' contract; the prompts ask for it and a before/after worktree check reverts any
// edits a pass makes anyway, so only the fix callback can change files. Synthesis and the overall
// risk are computed in code (see `../review/synthesize.ts`), not by the agent. The architecture
// pass can `block`, which is recorded as a high-risk banner - it does not halt the run. The
// resulting markdown becomes the `reviewSummary` artifact `open-pr` folds into the PR body.

import {
  defineStep,
  type Ctx,
  type Git,
  type GitStatus,
  type Harness,
  type RoundCheckInput,
  type Step,
} from "@tml/core";
import { executeRoundLoopWithApproval } from "../approval-gate.ts";
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

const REVIEW_PASS_TITLES = {
  context: "Context & intent",
  architecture: "Architecture & scope",
  correctness: "Correctness & testing",
  design: "Design & non-functional",
  micro: "Maintainability & nits",
} as const;

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
 *  prompt, those edits are reverted so they can't be misattributed to the fix pass and committed.
 *  The pipeline commits all prior work before review runs, and the round executor commits each
 *  fix before verification, so reverting to HEAD discards exactly the rogue edits. */
async function revertRogueEdits(
  git: Git,
  before: GitStatus,
  log: (m: string) => void,
): Promise<void> {
  if (touched(await git.status()) === touched(before)) return;
  log("warning: a read-only review pass modified the worktree; reverting before continuing");
  await git.discardChanges();
}

function withRoundHistory(prompt: string, input: RoundCheckInput): string {
  if (input.trigger === "initial") return prompt;
  const history = input.historyText.trim();
  if (history.length === 0 || history === "No prior rounds.") return prompt;
  return (
    prompt +
    "\n\nPrior review round history from this run. Use it explicitly: verify that previous " +
    "auto-fix findings were actually fixed, do not re-report resolved findings, and explain any " +
    "remaining or newly introduced findings against the current diff.\n" +
    history
  );
}

async function runReviewPasses(
  ctx: Ctx<readonly [typeof prBody]>,
  input: RoundCheckInput,
): Promise<ReviewPass[]> {
  const { agent } = ctx;
  const before = await ctx.git.status();
  const body = ctx.read(prBody);
  const context = await runPass(agent, withRoundHistory(contextPrompt(body), input));
  const understanding = context.understanding ?? "";
  const architecture = await runPass(
    agent,
    withRoundHistory(architecturePrompt(understanding), input),
    architectureSchema,
  );
  const correctness = await runPass(
    agent,
    withRoundHistory(correctnessPrompt(understanding), input),
  );
  const design = await runPass(agent, withRoundHistory(designPrompt(understanding), input));
  const micro = await runPass(agent, withRoundHistory(microPrompt(understanding), input));
  await revertRogueEdits(ctx.git, before, (m) => ctx.log(m));

  return [
    { title: REVIEW_PASS_TITLES.context, result: context },
    { title: REVIEW_PASS_TITLES.architecture, result: architecture },
    { title: REVIEW_PASS_TITLES.correctness, result: correctness },
    { title: REVIEW_PASS_TITLES.design, result: design },
    { title: REVIEW_PASS_TITLES.micro, result: micro },
  ];
}

function fixSummaries(rounds: readonly { readonly fixSummary?: string }[]): string {
  return rounds
    .map((round) => round.fixSummary?.trim() ?? "")
    .filter((summary) => summary.length > 0)
    .join("; ");
}

export function reviewStep(): Step {
  return defineStep({
    name: "review",
    consumes: [prBody],
    produces: [reviewSummary],
    async run(ctx) {
      let latestPasses: ReviewPass[] = [];

      const result = await executeRoundLoopWithApproval(ctx, {
        stepName: "review",
        async check(input) {
          latestPasses = await runReviewPasses(ctx, input);
          return { findings: latestPasses.flatMap((p) => p.result.findings) };
        },
        async fix(input) {
          const result = await ctx.agent.run(fixPrompt(input.findings, input.historyText));
          return { summary: result.summary };
        },
        commitMessage: "chore: apply fixes from review",
      });

      return {
        artifacts: {
          reviewSummary: summarize(latestPasses, fixSummaries(result.rounds), {
            fixedFindingIds: [],
          }),
        },
        rounds: result.rounds,
      };
    },
  });
}
