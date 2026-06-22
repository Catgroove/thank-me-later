// The agent-driven check Steps. `checkStep` is the shared shape: hand the agent a task and
// let it discover the toolchain and apply fixes (ARCHITECTURE - no tml-side detection). A
// non-`ok` result is work the agent could not finish on its own, so it escalates via
// `ctx.ask`. The four named checks differ only in their prompt.

import { defineStep, makeFinding, type Step } from "@tml/core";
import { formatPrompt, lintPrompt, testPrompt, typecheckPrompt } from "../prompts.ts";

export function checkStep(name: string, prompt: string): Step {
  return defineStep({
    name,
    async run(ctx) {
      const result = await ctx.agent.run(prompt);
      const finding = result.ok
        ? undefined
        : makeFinding(name, {
            severity: "error",
            action: "ask-user",
            title: `${name} incomplete`,
            detail: result.summary,
          });
      const findings = finding ? [finding] : [];
      const userNotes: Record<string, string> = {};
      if (finding) {
        const answer = await ctx.ask(`${name} could not be completed: ${result.summary}`);
        userNotes[finding.id] = answer;
      }
      await ctx.recordRound({
        trigger: "initial",
        findings,
        ...(Object.keys(userNotes).length > 0 ? { userNotes } : {}),
        ...(result.summary.trim().length > 0 ? { fixSummary: result.summary.trim() } : {}),
        commitSha: await ctx.git.headSha(),
      });
      return {};
    },
  });
}

export const formatStep = (): Step => checkStep("format", formatPrompt);
export const lintStep = (): Step => checkStep("lint", lintPrompt);
export const typecheckStep = (): Step => checkStep("typecheck", typecheckPrompt);
export const testStep = (): Step => checkStep("test", testPrompt);
