// `review` — a pre-push review of the branch's diff that mimics how a staff engineer reads a
// change: five focused read-only passes (context → architecture → correctness → design+NFR →
// micro), then one fix pass that applies the safe fixes the passes surfaced. Synthesis and the
// overall risk are computed in code (see `../review/synthesize.ts`), not by the agent. The
// architecture pass can `block`, which is recorded as a high-risk banner — it does not halt the
// run (the `ctx.ask` escalation that would gate the run is not implemented yet). The resulting
// markdown becomes the `reviewSummary` artifact `open-pr` folds into the PR body.

import { defineStep, type Harness, type Step } from "@tml/core";
import { prBody, reviewSummary } from "../artifacts.ts";
import {
  architecturePrompt,
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

/** Run one read-only review pass: structured reply against the findings schema, validated. */
async function runPass(agent: Harness, prompt: string): Promise<PassResult> {
  const result = await agent.run(prompt, { schema: findingsSchema });
  return parsePassResult(result.output);
}

export function reviewStep(): Step {
  return defineStep({
    name: "review",
    consumes: [prBody],
    produces: [reviewSummary],
    async run(ctx) {
      const { agent } = ctx;
      const context = await runPass(agent, contextPrompt(ctx.read(prBody)));
      const understanding = context.understanding ?? "";
      const architecture = await runPass(agent, architecturePrompt(understanding));
      const correctness = await runPass(agent, correctnessPrompt(understanding));
      const design = await runPass(agent, designPrompt(understanding));
      const micro = await runPass(agent, microPrompt(understanding));

      const passes: ReviewPass[] = [
        { title: "Context & intent", result: context },
        { title: "Architecture & scope", result: architecture },
        { title: "Correctness & testing", result: correctness },
        { title: "Design & non-functional", result: design },
        { title: "Maintainability & nits", result: micro },
      ];

      // Only safe, non-behavioural findings are auto-fixed; ask-user findings go to the human
      // via the summary. Skip the fix pass (and its agent call) when there's nothing to fix.
      const fixable = passes
        .flatMap((p) => p.result.findings)
        .filter((f) => f.action === "auto-fix");
      const fixSummary = fixable.length > 0 ? (await agent.run(fixPrompt(fixable))).summary : "";

      return { reviewSummary: summarize(passes, fixSummary) };
    },
  });
}
