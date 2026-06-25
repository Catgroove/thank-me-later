import type { RunEvent } from "@tml/core";
import type { StepView, ViewState } from "./present.ts";
import { displayStepName } from "./step-display.ts";

export const RESULT_LABEL_WIDTH = 8;
const INLINE_ARTIFACT_MAX = 56;

/** A long or multi-line artifact reads as narrative: shown in the results block, not inline. */
export function isNarrativeArtifact(rendered: string): boolean {
  return rendered.includes("\n") || rendered.length > INLINE_ARTIFACT_MAX;
}

export function approvalPrompt(event: Extract<RunEvent, { type: "approval:pending" }>): string {
  const count = event.input.findings.length;
  const suffix = count === 1 ? "1 finding" : `${count} findings`;
  return `${event.input.prompt} (${suffix})`;
}

export function narrativeSteps(view: ViewState): (StepView & { headline: string })[] {
  return view.steps.filter(
    (step): step is StepView & { headline: string } =>
      step.headline !== undefined && isNarrativeArtifact(step.headline),
  );
}

export function resultLabelWidth(
  steps: readonly (StepView & { headline: string })[],
  hasPrUrl: boolean,
): number {
  return Math.max(
    RESULT_LABEL_WIDTH,
    ...steps.map((step) => displayStepName(step).length + 2),
    hasPrUrl ? "pr".length + 2 : 0,
  );
}
