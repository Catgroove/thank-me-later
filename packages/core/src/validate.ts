// Assembly-time validation (ADR-0003): check the whole assembled Pipeline before
// any side effect, so a misconfigured Pipeline fails before a branch is pushed
// or a PR opened. Only the statically-knowable rules live here — the artifact
// dependency graph and step-name uniqueness. A `goto` target is a value a Step
// returns at *runtime*, so the engine validates that when the signal is emitted,
// not here.

import type { Pipeline } from "./pipeline.ts";

export class AssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyError";
  }
}

export function validatePipeline(pipeline: Pipeline): void {
  const seenSteps = new Set<string>();
  const producedBy = new Map<string, string>();

  for (const step of pipeline) {
    if (seenSteps.has(step.name)) {
      throw new AssemblyError(
        `Two Steps are named "${step.name}"; Step names must be unique within a Pipeline.`,
      );
    }
    seenSteps.add(step.name);

    // Every consumed artifact must already have a producer earlier in order.
    for (const artifact of step.consumes) {
      if (!producedBy.has(artifact.name)) {
        throw new AssemblyError(
          `Step "${step.name}" consumes artifact "${artifact.name}", but no earlier Step produces it.`,
        );
      }
    }

    // Register produced artifacts; a name may have only one producer.
    for (const artifact of step.produces) {
      const existing = producedBy.get(artifact.name);
      if (existing !== undefined) {
        throw new AssemblyError(
          `Artifact "${artifact.name}" is produced by both "${existing}" and "${step.name}"; producers must be unique.`,
        );
      }
      producedBy.set(artifact.name, step.name);
    }
  }
}
