// `review` - a pre-push thermo-nuclear maintainability audit of the branch's diff. The check is
// one read-only agent pass based on Cursor's thermo-nuclear code quality review skill, followed by
// the shared round loop for safe auto-fixes and verification. The before/after worktree check
// reverts any edits the read-only pass makes anyway, so only the fix callback can change files.
// The resulting markdown becomes the `reviewSummary` artifact `open-pr` folds into the PR body.

import {
  defineStep,
  executeRoundLoop,
  type Ctx,
  type Finding,
  type Harness,
  type RoundCheckInput,
  type Step,
} from "@tml/core";
import { prBody, reviewSummary } from "../artifacts.ts";
import { revertIfWorktreeChanged } from "../git-guard.ts";
import { findingsSchema, fixPrompt, reviewPrompt } from "../prompts.ts";
import {
  type PassResult,
  type ReviewPass,
  parsePassResult,
  summarize,
} from "../review/synthesize.ts";

const REVIEW_PASS_TITLE = "Thermo-nuclear code quality review";

/** Run the read-only review pass: structured reply against the findings schema, validated. */
async function runPass(agent: Harness, prompt: string): Promise<PassResult> {
  const result = await agent.run(prompt, { schema: findingsSchema });
  return parsePassResult(result.output);
}

const READ_ONLY_EDIT_WARNING =
  "warning: the read-only review pass modified the worktree; reverting before continuing";

async function runGuardedPass(ctx: Ctx, prompt: string): Promise<PassResult> {
  const before = await ctx.git.status();
  try {
    return await runPass(ctx.agent, prompt);
  } finally {
    await revertIfWorktreeChanged(ctx.git, before, (m) => ctx.log(m), READ_ONLY_EDIT_WARNING);
  }
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

/** A human label grouping a round's pass, so the presenter can show the current round only. */
function passGroup(input: RoundCheckInput): string {
  return input.trigger === "initial" ? "initial" : `verify · attempt ${input.attempt}`;
}

/** The pass's findings, surfaced live as the phase resolves. */
const passFindings = (result: PassResult): readonly Finding[] => result.findings;

function reviewFindings(passes: readonly ReviewPass[]): Finding[] {
  return passes.flatMap((pass) => pass.result.findings);
}

async function runReviewPasses(
  ctx: Ctx<readonly [typeof prBody]>,
  input: RoundCheckInput,
): Promise<ReviewPass[]> {
  const prompt = reviewPrompt({
    prBody: ctx.read(prBody),
    diff: await ctx.git.diffAgainst(await ctx.git.defaultBranch()),
  });
  const result = await ctx.phase(
    REVIEW_PASS_TITLE,
    () => runGuardedPass(ctx, withRoundHistory(prompt, input)),
    { group: passGroup(input), findings: passFindings },
  );
  return [{ title: REVIEW_PASS_TITLE, result }];
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

      const result = await executeRoundLoop(ctx, {
        stepName: "review",
        async check(input) {
          latestPasses = await runReviewPasses(ctx, input);
          return { findings: reviewFindings(latestPasses) };
        },
        async fix(input) {
          return ctx.phase(
            "Apply fixes",
            async () => {
              const result = await ctx.agent.run(fixPrompt(input.findings, input.historyText));
              return { summary: result.summary };
            },
            { group: `fix · attempt ${input.attempt}` },
          );
        },
        commitMessage: "chore: apply fixes from review",
        recordRounds: "live",
      });

      return {
        artifacts: {
          reviewSummary: summarize(latestPasses, fixSummaries(result.rounds), {
            fixedFindingIds: [],
          }),
        },
        rounds: [],
      };
    },
  });
}
