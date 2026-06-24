// The agent-driven check Steps. Each check is a core round loop: a fresh read-only check pass
// produces structured Findings, a fresh fix pass handles selected auto-fix Findings, and a fresh
// verification pass confirms the result. Toolchain discovery stays inside the prompts - tml never
// hardcodes repo-specific commands.

import {
  defineStep,
  executeRoundLoop,
  makeFinding,
  parseAgentFindingsOutput,
  type Ctx,
  type Finding,
  type GitStatus,
  type Step,
} from "@tml/core";
import { revertIfWorktreeChanged } from "../git-guard.ts";
import type { FixLoopPolicy } from "./fix-loop.ts";
import {
  type CheckMode,
  checkFindingsSchema,
  checkFixPrompt,
  checkPrompt,
  formatPrompt,
  lintPrompt,
  testPrompt,
  typecheckPrompt,
} from "../prompts.ts";

interface CheckPolicy {
  readonly groundRules: string;
  before(ctx: Ctx): Promise<GitStatus>;
  after(ctx: Ctx, before: GitStatus): Promise<void>;
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
    before: (ctx) => ctx.git.status(),
    async after(ctx, before) {
      await revertIfWorktreeChanged(
        ctx.git,
        before,
        (m) => ctx.log(m),
        "warning: a check round modified the worktree; reverting before continuing",
      );
    },
  },
  run: {
    groundRules:
      "\n\nThis is a check/verification round, not a fix round. Run the check's command to judge " +
      "the repository, building or installing whatever it needs to run. Do not edit source " +
      "files, stage changes, commit, or apply a mutating auto-fix; if a problem can only be " +
      "repaired by changing files, return an auto-fix finding for the later fix round. ",
    before: (ctx) => ctx.git.status(),
    async after(ctx, before) {
      await revertIfWorktreeChanged(
        ctx.git,
        before,
        (m) => ctx.log(m),
        "check command left worktree changes; cleaning up before continuing",
      );
    },
  },
};

export function checkStep(name: string, goal: string, options: CheckStepOptions = {}): Step {
  return defineStep({
    name,
    async run(ctx) {
      const policy = checkPolicies[options.mode ?? "inspect"];
      const result = await executeRoundLoop(ctx, {
        stepName: name,
        maxAutoFixAttempts: options.maxAutoFixAttempts,
        async check(input) {
          const before = await policy.before(ctx);
          let agentResult: Awaited<ReturnType<typeof ctx.agent.run>>;
          try {
            agentResult = await ctx.agent.run(
              checkPrompt({ name, goal, groundRules: policy.groundRules, ...input }),
              { schema: checkFindingsSchema },
            );
          } finally {
            await policy.after(ctx, before);
          }
          return {
            findings: parseCheckResult(
              name,
              agentResult.output,
              agentResult.summary,
              agentResult.ok,
            ),
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
        commitMessage: `chore: apply fixes from ${name}`,
      });

      return { artifacts: {}, rounds: result.rounds };
    },
  });
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

export const formatStep = (policy: FixLoopPolicy = {}): Step =>
  checkStep("format", formatPrompt, { ...policy, mode: "inspect" });
export const lintStep = (policy: FixLoopPolicy = {}): Step =>
  checkStep("lint", lintPrompt, { ...policy, mode: "inspect" });
export const typecheckStep = (policy: FixLoopPolicy = {}): Step =>
  checkStep("typecheck", typecheckPrompt, { ...policy, mode: "run" });
export const testStep = (policy: FixLoopPolicy = {}): Step =>
  checkStep("test", testPrompt, { ...policy, mode: "run" });
