// The agent-driven check Steps. `checkStep` is the shared shape: hand the agent a task and
// let it discover the toolchain and apply fixes (ARCHITECTURE — no tml-side detection). A
// non-`ok` result is work the agent could not finish on its own, so it escalates via
// `ctx.ask`. The four named checks differ only in their prompt.

import { defineStep, type Step } from "@tml/core";
import { formatPrompt, lintPrompt, testPrompt, typecheckPrompt } from "../prompts.ts";

export function checkStep(name: string, prompt: string): Step {
  return defineStep({
    name,
    async run(ctx) {
      const result = await ctx.agent.run(prompt);
      if (!result.ok) await ctx.ask(`${name} could not be completed: ${result.summary}`);
      return {};
    },
  });
}

export const formatStep = (): Step => checkStep("format", formatPrompt);
export const lintStep = (): Step => checkStep("lint", lintPrompt);
export const typecheckStep = (): Step => checkStep("typecheck", typecheckPrompt);
export const testStep = (): Step => checkStep("test", testPrompt);
