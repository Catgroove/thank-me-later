// `review` - a pre-push thermo-nuclear maintainability audit of the branch's diff. The check is
// one read-only agent pass based on Cursor's thermo-nuclear code quality review skill, followed by
// the shared round loop for safe auto-fixes and verification. The before/after worktree check
// reverts any edits the read-only pass makes anyway, so only the fix callback can change files.
// The resulting markdown becomes the `reviewSummary` artifact `open-pr` folds into the PR body.

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
import { revertIfWorktreeChanged } from "../git-guard.ts";
import type { FixLoopPolicy } from "./fix-loop.ts";
import { findingsSchema, fixPrompt, reviewPrompt } from "../prompts.ts";
import { parseReviewFindings, summarize } from "../review/synthesize.ts";
import { fixCommitSubject } from "../semantic-commit.ts";

const REVIEW_PASS_TITLE = "Thermo-nuclear code quality review";

/** Run the read-only review pass: structured reply against the findings schema, validated. */
async function runPass(agent: Harness, prompt: string): Promise<Finding[]> {
  const result = await agent.run(prompt, { schema: findingsSchema });
  return parseReviewFindings(result.output);
}

const READ_ONLY_EDIT_WARNING =
  "warning: the read-only review pass modified the worktree; reverting before continuing";

async function runGuardedPass(ctx: Ctx, prompt: string): Promise<Finding[]> {
  const before = await ctx.git.status();
  try {
    return await runPass(ctx.agent, prompt);
  } finally {
    await revertIfWorktreeChanged(ctx.git, before, (m) => ctx.log(m), READ_ONLY_EDIT_WARNING);
  }
}

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
    diff: await ctx.git.diffAgainst(await ctx.git.defaultBranch()),
  });
  return ctx.phase(REVIEW_PASS_TITLE, () => runGuardedPass(ctx, withRoundHistory(prompt, input)), {
    group: passGroup(input),
    findings: (findings) => findings,
  });
}

function fixSummaries(rounds: readonly { readonly fixSummary?: string }[]): string {
  return rounds
    .map((round) => round.fixSummary?.trim() ?? "")
    .filter((summary) => summary.length > 0)
    .join("; ");
}

export function reviewStep(policy: FixLoopPolicy = {}): Step {
  return defineStep({
    name: "review",
    consumes: [prBody],
    produces: [reviewSummary],
    async run(ctx) {
      let latestFindings: Finding[] = [];

      const result = await executeRoundLoop(ctx, {
        stepName: "review",
        async check(input) {
          latestFindings = await runReviewPass(ctx, input);
          return { findings: latestFindings };
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
        maxAutoFixAttempts: policy.maxAutoFixAttempts,
        recordRounds: "live",
      });

      return {
        artifacts: {
          reviewSummary: summarize(latestFindings, fixSummaries(result.rounds)),
        },
        rounds: [],
      };
    },
  });
}
