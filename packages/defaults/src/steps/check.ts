// The agent-driven check Steps. `checkStep` is the shared shape: hand the agent a task and
// let it discover the toolchain and apply fixes (ARCHITECTURE - no tml-side detection). A
// non-`ok` result becomes an ask-user Finding in the returned round. The four named checks
// differ only in their prompt.

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
      return {
        artifacts: {},
        rounds: [{ trigger: "initial", findings: finding ? [finding] : [] }],
      };
    },
  });
}

export const formatStep = (): Step => checkStep("format", formatPrompt);
export const lintStep = (): Step => checkStep("lint", lintPrompt);
export const typecheckStep = (): Step => checkStep("typecheck", typecheckPrompt);
export const testStep = (): Step => checkStep("test", testPrompt);
