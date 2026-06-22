// The Step contract: one addressable unit of work in a Pipeline. A Step declares
// the artifacts it `consumes` and `produces`, and a `run` that returns produced values,
// a structured StepResult (artifacts plus completed rounds), or a FlowSignal. Steps stay
// mostly-pure and unit-testable; side effects go through the Providers on `ctx`.

import type { Artifact, Produced } from "./artifact.ts";
import type { Ctx } from "./context.ts";
import type { RoundRecordInput } from "./round.ts";
import type { FlowSignal } from "./signals.ts";

type Artifacts = readonly Artifact<unknown, string>[];

/**
 * How the engine treats a completed Step when resuming from the Run Journal.
 *
 * - `replay` (default): before any reconciliation boundary, a completed Step can be skipped and
 *   its persisted artifacts loaded from the journal.
 * - `reconcile`: never skip this Step from the journal, and stop replaying later Steps. Use this
 *   for post-PR or other Provider-derived facts that must be refreshed from the world.
 */
export type StepResumePolicy = "replay" | "reconcile";

export interface StepResult<P extends Artifacts> {
  readonly artifacts: Produced<P>;
  readonly rounds?: readonly RoundRecordInput[];
}

export type StepRun<C extends Artifacts, P extends Artifacts> = (
  ctx: Ctx<C>,
) => Promise<Produced<P> | StepResult<P> | FlowSignal>;

export interface Step<C extends Artifacts = Artifacts, P extends Artifacts = Artifacts> {
  readonly name: string;
  readonly consumes: C;
  readonly produces: P;
  readonly run: StepRun<C, P>;
  readonly resume?: StepResumePolicy;
}

export function defineStep<
  const C extends Artifacts = readonly [],
  const P extends Artifacts = readonly [],
>(def: {
  name: string;
  consumes?: C;
  produces?: P;
  run: StepRun<C, P>;
  resume?: StepResumePolicy;
}): Step<C, P> {
  return {
    name: def.name,
    consumes: def.consumes ?? ([] as unknown as C),
    produces: def.produces ?? ([] as unknown as P),
    run: def.run,
    resume: def.resume ?? "replay",
  };
}
