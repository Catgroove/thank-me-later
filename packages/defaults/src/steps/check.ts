// The agent-driven check Steps. Each check is a core round loop: a fresh read-only check pass
// produces structured Findings, a fresh fix pass handles selected auto-fix Findings, and a fresh
// verification pass confirms the result. Toolchain discovery stays inside the prompts - tml never
// hardcodes repo-specific commands.

import {
  defineStep,
  executeRoundLoop,
  makeFinding,
  parseAgentFindingsOutput,
  type Finding,
  type Step,
} from "@tml/core";
import { guardReadOnly } from "../git-guard.ts";
import type { FixLoopPolicy } from "./fix-loop.ts";
import {
  type CheckMode,
  checkFindingsSchema,
  checkFixPrompt,
  checkPrompt,
  qualityPrompt,
  testPrompt,
} from "../prompts.ts";
import { fixCommitSubject } from "../semantic-commit.ts";

interface CheckPolicy {
  readonly groundRules: string;
  /** Warning logged when the read-only check pass leaves worktree edits behind, then reverted. */
  readonly warning: string;
}

export interface CheckStepOptions extends FixLoopPolicy {
  readonly mode?: CheckMode;
}

const checkPolicies: Record<CheckMode, CheckPolicy> = {
  inspect: {
    groundRules:
      "\n\nThis is a check/verification round, not a fix round. Do not modify files, stage " +
      "changes, commit, install dependencies, or run a mutating auto-fix command. Inspect files " +
      "directly instead of invoking local quality tools. If a tool can only prove or repair the " +
      "problem by changing files, return an auto-fix finding for the later fix round. ",
    warning: "warning: a check round modified the worktree; reverting before continuing",
  },
  mixed: {
    groundRules:
      "\n\nThis is a check/verification round, not a fix round. For source-inspection checks, " +
      "inspect files directly instead of invoking local quality tools. For command-backed " +
      "checks, run the non-mutating check command needed to judge the repository, building or " +
      "installing dependencies only when the command cannot run otherwise. Do not edit source " +
      "files, stage changes, commit, or apply a mutating auto-fix; if a problem can only be " +
      "repaired by changing files, return an auto-fix finding for the later fix round. ",
    warning: "check command left worktree changes; cleaning up before continuing",
  },
  run: {
    groundRules:
      "\n\nThis is a check/verification round, not a fix round. Run the check's command to judge " +
      "the repository, building or installing whatever it needs to run. Do not edit source " +
      "files, stage changes, commit, or apply a mutating auto-fix; if a problem can only be " +
      "repaired by changing files, return an auto-fix finding for the later fix round. ",
    warning: "check command left worktree changes; cleaning up before continuing",
  },
};

export function checkStep(name: string, goal: string, mode: CheckMode): Step;
export function checkStep(name: string, goal: string, options?: CheckStepOptions): Step;
export function checkStep(
  name: string,
  goal: string,
  modeOrOptions: CheckMode | CheckStepOptions = {},
): Step {
  const options = normalizeCheckStepOptions(modeOrOptions);
  return defineStep({
    name,
    async run(ctx) {
      const policy = checkPolicies[options.mode ?? "inspect"];
      const result = await executeRoundLoop(ctx, {
        stepName: name,
        maxAutoFixAttempts: options.maxAutoFixAttempts,
        async check(input) {
          const agentResult = await guardReadOnly(ctx, policy.warning, () =>
            ctx.agent.run(checkPrompt({ name, goal, groundRules: policy.groundRules, ...input }), {
              schema: checkFindingsSchema,
            }),
          );
          return {
            findings: parseCheckResult(
              name,
              agentResult.output,
              agentResult.summary,
              agentResult.ok,
            ),
            testing: {
              summary: agentResult.summary,
              tested: policy === checkPolicies.run,
            },
          };
        },
        async fix(input) {
          const agentResult = await ctx.agent.run(
            checkFixPrompt({
              name,
              goal,
              findings: input.findings,
              historyText: input.historyText,
            }),
          );
          return { summary: agentResult.summary };
        },
        commitMessage: (_input, result) => fixCommitSubject(name, result.summary),
      });

      return { artifacts: {}, rounds: result.rounds };
    },
  });
}

function normalizeCheckStepOptions(modeOrOptions: CheckMode | CheckStepOptions): CheckStepOptions {
  return typeof modeOrOptions === "string" ? { mode: modeOrOptions } : modeOrOptions;
}

function parseCheckResult(name: string, output: unknown, summary: string, ok: boolean): Finding[] {
  if (output === undefined) {
    return ok
      ? []
      : [
          makeFinding(name, {
            disposition: "blocker",
            action: "ask-user",
            title: `${name} check did not return structured findings`,
            detail: summary,
          }),
        ];
  }
  return parseAgentFindingsOutput(output, { namespace: name, sourceName: name });
}

export const qualityStep = (policy: FixLoopPolicy = {}): Step => ({
  ...checkStep("quality", qualityPrompt, { ...policy, mode: "mixed" }),
  display: { label: "Quality" },
});
export const testStep = (policy: FixLoopPolicy = {}): Step => ({
  ...checkStep("test", testPrompt, { ...policy, mode: "run" }),
  display: { label: "Test" },
});
