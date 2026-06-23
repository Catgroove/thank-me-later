// The agent-driven check Steps. Each check is a core round loop: a fresh read-only check pass
// produces structured Findings, a fresh fix pass handles selected auto-fix Findings, and a fresh
// verification pass confirms the result. Toolchain discovery stays inside the prompts - tml never
// hardcodes repo-specific commands.

import { defineStep, makeFinding, type Finding, type Step } from "@tml/core";
import { executeRoundLoopWithApproval } from "../approval-gate.ts";
import { parseAgentFindingsOutput } from "../findings.ts";
import { revertIfWorktreeChanged } from "../git-guard.ts";
import {
  checkFindingsSchema,
  checkFixPrompt,
  checkPrompt,
  formatPrompt,
  lintPrompt,
  testPrompt,
  typecheckPrompt,
} from "../prompts.ts";

export function checkStep(name: string, goal: string): Step {
  return defineStep({
    name,
    async run(ctx) {
      const result = await executeRoundLoopWithApproval(ctx, {
        stepName: name,
        async check(input) {
          const before = await ctx.git.status();
          const agentResult = await ctx.agent.run(checkPrompt({ name, goal, ...input }), {
            schema: checkFindingsSchema,
          });
          await revertIfWorktreeChanged(
            ctx.git,
            before,
            (m) => ctx.log(m),
            "warning: a check round modified the worktree; reverting before continuing",
          );
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
            severity: "error",
            action: "ask-user",
            title: `${name} check did not return structured findings`,
            detail: summary,
          }),
        ];
  }
  return parseAgentFindingsOutput(output, { namespace: name, sourceName: name });
}

export const formatStep = (): Step => checkStep("format", formatPrompt);
export const lintStep = (): Step => checkStep("lint", lintPrompt);
export const typecheckStep = (): Step => checkStep("typecheck", typecheckPrompt);
export const testStep = (): Step => checkStep("test", testPrompt);
