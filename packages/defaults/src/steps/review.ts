// `review` - a pre-push read-only review of the branch's diff for bugs, risks, and safe
// simplifications. One agent pass triages findings by action; safe auto-fix findings get a single
// fire-and-forget fix pass (no re-review), while findings that touch the author's intent are flagged
// for the human approval gate. So a clean diff is one pass, obvious fixes cost one more, and
// judgement calls reach the operator once - the step never re-reviews and so never churns. The
// before/after worktree check reverts any edits the read-only pass makes anyway, so only the fix
// callback can change files. The resulting markdown becomes the `reviewSummary` artifact `open-pr`
// folds into the PR body.

import {
  defineStep,
  executeRoundLoop,
  hasPriorRounds,
  type Ctx,
  type Finding,
  type Harness,
  type RoundCheckInput,
  type Step,
} from "@tml/core";
import { prBody, reviewSummary } from "../artifacts.ts";
import { guardReadOnly } from "../git-guard.ts";
import { findingsSchema, fixPrompt, reviewPrompt } from "../prompts.ts";
import { parseReviewFindings, summarize } from "../review/synthesize.ts";
import { fixCommitSubject } from "../semantic-commit.ts";

const REVIEW_PASS_TITLE = "Code review";

// Review fixes obvious, safe findings once (fire-and-forget, no re-review) and routes judgement
// calls to the human gate. Unlike the objective checks (quality/test/ci), re-reviewing a
// maintainability pass does not converge, so review does not take the global maxFixAttempts knob -
// it has its own low budget and `verifyAfterFix: false`.
const REVIEW_AUTO_FIX_ATTEMPTS = 1;

/** Run the read-only review pass: structured reply against the findings schema, validated. */
async function runPass(agent: Harness, prompt: string): Promise<Finding[]> {
  const result = await agent.run(prompt, { schema: findingsSchema });
  return parseReviewFindings(result.output);
}

const READ_ONLY_EDIT_WARNING =
  "warning: the read-only review pass modified the worktree; reverting before continuing";

function withRoundHistory(prompt: string, input: RoundCheckInput): string {
  if (input.trigger === "initial" || !hasPriorRounds(input.historyText)) return prompt;
  return (
    prompt +
    "\n\nPrior review round history from this run. You own reconciliation for this verify " +
    "pass: compare the current diff against the prior findings, confirm which selected " +
    "auto-fix findings are resolved, do not re-report resolved findings, and report only " +
    "issues still present or newly introduced.\n" +
    input.historyText.trim()
  );
}

/** A human label grouping a round's pass, so the presenter can show the current round only. */
function passGroup(input: RoundCheckInput): string {
  return input.trigger === "initial" ? "initial" : `verify · attempt ${input.attempt}`;
}

async function runReviewPass(
  ctx: Ctx<readonly [typeof prBody]>,
  input: RoundCheckInput,
): Promise<Finding[]> {
  const prompt = reviewPrompt({
    prBody: ctx.read(prBody),
    base: await ctx.git.defaultBranch(),
  });
  return ctx.phase(
    REVIEW_PASS_TITLE,
    () =>
      guardReadOnly(ctx, READ_ONLY_EDIT_WARNING, () =>
        runPass(ctx.agent, withRoundHistory(prompt, input)),
      ),
    { group: passGroup(input), findings: (findings) => findings },
  );
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
      const result = await executeRoundLoop(ctx, {
        stepName: "review",
        async check(input) {
          const findings = await runReviewPass(ctx, input);
          return { findings };
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
        commitMessage: (_input, result) => fixCommitSubject("review", result.summary),
        maxAutoFixAttempts: REVIEW_AUTO_FIX_ATTEMPTS,
        // Review is a judgement pass: apply safe fixes once and stop. A re-review would not
        // converge and would re-surface findings the operator already decided on.
        verifyAfterFix: false,
        recordRounds: "live",
      });

      return {
        artifacts: {
          reviewSummary: summarize(result.findings, fixSummaries(result.rounds)),
        },
        rounds: [],
      };
    },
  });
}
