import type { ViewState } from "./present.ts";

export interface DisplayedStep {
  readonly name: string;
  readonly displayLabel: string;
  readonly displayGroup?: string;
}

export type PipelineDisplayRow<T extends DisplayedStep> =
  | { readonly kind: "group"; readonly label: string }
  | {
      readonly kind: "step";
      readonly label: string;
      readonly grouped: boolean;
      readonly step: T;
      readonly stepIndex: number;
    };

export function displayStepName(step: DisplayedStep): string {
  return step.displayGroup === undefined
    ? step.displayLabel
    : `${step.displayGroup}/${step.displayLabel}`;
}

export function displayStepNameFor(view: ViewState, name: string): string {
  const step = view.steps.find((s) => s.name === name);
  return step === undefined ? name : displayStepName(step);
}

export function pipelineDisplayRows<T extends DisplayedStep>(
  steps: readonly T[],
): PipelineDisplayRow<T>[] {
  const rows: PipelineDisplayRow<T>[] = [];
  let previousGroup: string | undefined;
  steps.forEach((step, stepIndex) => {
    const group = step.displayGroup;
    if (group !== undefined && group !== previousGroup) rows.push({ kind: "group", label: group });
    rows.push({
      kind: "step",
      label: step.displayLabel,
      grouped: group !== undefined,
      step,
      stepIndex,
    });
    previousGroup = group;
  });
  return rows;
}
