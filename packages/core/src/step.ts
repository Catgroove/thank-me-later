// The Step contract: one addressable unit of work in a Pipeline. A Step declares
// the artifacts it `consumes` and `produces`, and a `run` that either returns its
// produced values (keyed by artifact name) *or* a FlowSignal — never both
// (mirrors `Output | FlowSignal`). Steps stay mostly-pure and unit-testable;
// side effects go through the Providers on `ctx`.

import type { Artifact, Produced } from "./artifact.ts";
import type { Ctx } from "./context.ts";
import type { FlowSignal } from "./signals.ts";

type Artifacts = readonly Artifact<unknown, string>[];

export type StepRun<C extends Artifacts, P extends Artifacts> = (
  ctx: Ctx<C>,
) => Promise<Produced<P> | FlowSignal>;

export interface Step<C extends Artifacts = Artifacts, P extends Artifacts = Artifacts> {
  readonly name: string;
  readonly consumes: C;
  readonly produces: P;
  readonly run: StepRun<C, P>;
}

export function defineStep<
  const C extends Artifacts = readonly [],
  const P extends Artifacts = readonly [],
>(def: { name: string; consumes?: C; produces?: P; run: StepRun<C, P> }): Step<C, P> {
  return {
    name: def.name,
    consumes: def.consumes ?? ([] as unknown as C),
    produces: def.produces ?? ([] as unknown as P),
    run: def.run,
  };
}
