// @tml/core — the engine and the curated public surface plugins peer-depend on.
// Only what is re-exported here is public; everything else (the flow-signal brand
// and guard, the run-loop internals) stays private to the package.

export { type Artifact, defineArtifact, type Produced } from "./artifact.ts";
export { cancel, type FlowSignal, goto, retry, skip } from "./signals.ts";
export { AbortError, type Pending, type PollResult, TimeoutError, until } from "./pending.ts";
export type { Ctx } from "./context.ts";
export { defineStep, type Step, type StepRun } from "./step.ts";
export {
  type Config,
  defineConfig,
  definePlugin,
  type ModelMap,
  type Pipeline,
  type Plugin,
  type Providers,
} from "./pipeline.ts";
export { type CommitResult, createGit, type Git, type GitStatus } from "./providers/git.ts";
export type {
  CheckRun,
  Forge,
  Mergeable,
  OpenPullRequestInput,
  PullRequest,
  ReviewThread,
} from "./providers/forge.ts";
export type { AgentProgress, AgentResult, AgentRunOpts, Harness } from "./providers/harness.ts";
export type { RunEvent } from "./events.ts";
export { createEngine, type Engine, type EngineOptions, NotImplementedError } from "./engine.ts";
export { AssemblyError, validatePipeline } from "./validate.ts";
