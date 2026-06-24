// @tml/core — the engine and the curated public surface plugins peer-depend on.
// Only what is re-exported here is public; everything else (the flow-signal brand
// and guard, the run-loop internals) stays private to the package.

export {
  type ApprovalDecision,
  type ApproveDecision,
  type ApproveFindingsInput,
  type AbortDecision,
  type FixDecision,
  type SkipDecision,
} from "./approval.ts";
export { type Artifact, defineArtifact, type Produced } from "./artifact.ts";
export { cancel, type FlowSignal, goto, retry, skip } from "./signals.ts";
export { AbortError, type Pending, type PollResult, TimeoutError, until } from "./pending.ts";
export type { Ctx, PhaseOptions } from "./context.ts";
export {
  type Finding,
  type FindingAction,
  type FindingDisposition,
  type FindingInput,
  type FindingLifecycle,
  type FindingStatus,
  type ParseAgentFindingsOptions,
  type RoundRecord,
  type RoundRecordInput,
  type RoundResolution,
  type RoundTrigger,
  type StepRoundSummary,
  currentFindings,
  findingId,
  findingLifecycle,
  hasPriorRounds,
  isFixAttemptRound,
  makeFinding,
  parseAgentFindingsOutput,
  renderFindingForPr,
  renderPipelineSummaryForPr,
  renderRoundsForPr,
  renderRoundsForPrompt,
  renderUnresolvedFindingsForPr,
  summarizeStepRounds,
} from "./round.ts";
export {
  executeRoundLoop,
  type RoundCheckInput,
  type RoundCheckResult,
  type RoundCommitInput,
  type RoundCommitResult,
  type RoundFixInput,
  type RoundFixResult,
  type RoundLoopOptions,
  type RoundLoopResult,
  type RoundLoopStopReason,
  type RoundStopPolicyInput,
} from "./round-executor.ts";
export { defineStep, type Step, type StepResult, type StepRun } from "./step.ts";
export { type Config, type ModelMap, type Pipeline, type Providers } from "./pipeline.ts";
export {
  type Assembly,
  createAssembly,
  type GitProviderFactory,
  type HarnessFactory,
  type PipelineBuilder,
  type Plugin,
  type ResolvedKnobs,
  type Selection,
  type Tml,
} from "./assembly.ts";
export {
  type CommitResult,
  createGit,
  type Git,
  type GitStatus,
  type RebaseResult,
} from "./providers/git.ts";
export type {
  BlockingMergeState,
  CheckRun,
  GitProvider,
  Mergeable,
  MergeableMergeState,
  MergeState,
  MergeStateKind,
  OpenPullRequestInput,
  PullRequest,
  UnsettledMergeState,
} from "./providers/git-provider.ts";
export { isMergeable, mergeStateKind } from "./providers/git-provider.ts";
export type { AgentProgress, AgentResult, AgentRunOpts, Harness } from "./providers/harness.ts";
export type { RunEvent, RunEventInput } from "./events.ts";
export { createEngine, type Engine, type EngineOptions } from "./engine.ts";
export {
  checkoutKeyForPath,
  createRunJournal,
  type CreateRunJournalOptions,
  type RunJournal,
  type RunJournalResumeMode,
  type RunJournalSnapshot,
  type RunMetadata,
  type RunStatus,
  type RunWorktreeHandoff,
} from "./run-journal.ts";
export { createWorktree, currentWorkspaceSourceBranch, removeWorktree } from "./workspace.ts";
export { AssemblyError, isolationBoundaryFor, validatePipeline } from "./validate.ts";
export type { IsolationBoundary } from "./validate.ts";
