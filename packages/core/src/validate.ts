// Assembly-time validation: check the whole assembled Pipeline before
// any side effect, so a misconfigured Pipeline fails before a branch is pushed
// or a PR opened. Only the statically-knowable rules live here — the artifact
// dependency graph and step-name uniqueness. A `goto` target is a value a Step
// returns at *runtime*, so the engine validates that when the signal is emitted,
// not here.

import type { ModelMap, Pipeline } from "./pipeline.ts";

export class AssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyError";
  }
}

export function validatePipeline(pipeline: Pipeline, models?: ModelMap): void {
  const seenSteps = new Set<string>();
  const producedBy = new Map<string, string>();

  for (const step of pipeline) {
    if (step.name === "default") {
      throw new AssemblyError(
        `A Step is named "default", but "default" is reserved as the run-wide model key. ` +
          `Rename the Step.`,
      );
    }
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

  // Every `models` key other than the reserved `default` must name a Step. This
  // catches typos — the cost of string keys — before any side effect. (Whether a keyed Step
  // actually uses the agent is *not* checked: the engine can't see inside `run`, and a model
  // on a non-agent Step is merely inert.)
  if (models !== undefined) {
    if (typeof models !== "object" || models === null || Array.isArray(models)) {
      throw new AssemblyError("models must be an object of step-name → model id.");
    }
    for (const [key, value] of Object.entries(models)) {
      if (value !== undefined && typeof value !== "string") {
        const where = key === "default" ? "models.default" : `models["${key}"]`;
        throw new AssemblyError(`${where} must be a string model id.`);
      }
      if (key === "default" || seenSteps.has(key)) continue;
      const names = [...seenSteps];
      const near = names.find((name) => withinEditDistanceOne(key, name));
      const hint =
        near !== undefined
          ? ` (did you mean "${near}"?)`
          : ` (valid step names: ${names.map((n) => `"${n}"`).join(", ")})`;
      throw new AssemblyError(`models key "${key}" matches no Step${hint}.`);
    }
  }
}

/** True when `a` and `b` differ by at most one insertion, deletion, or substitution. */
function withinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) return false;

  if (shorter.length === longer.length) {
    // Same length → at most one substitution allowed.
    let diffs = 0;
    for (let i = 0; i < shorter.length; i += 1) {
      if (shorter[i] !== longer[i] && (diffs += 1) > 1) return false;
    }
    return true;
  }

  // Length differs by one → the shorter must be the longer with one char removed.
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j += 1;
    }
  }
  return true;
}
