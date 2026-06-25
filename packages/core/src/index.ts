// @tml/core — the engine and the curated public surface plugins peer-depend on.
// Only what is re-exported here is public; everything else (the flow-signal brand
// and guard, the run-loop internals) stays private to the package.

export {
  type AbortDecision,
  type ApprovalDecision,
  type ApprovalFindingsInput,
  type ApproveDecision,
  type ApproveFindingsInput,
  type FixDecision,
  isRoundApproveFindingsInput,
  type RoundApprovalFixBudget,
  type RoundApproveFindingsInput,
  type RoundLoopStopReason,
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
  type RoundTestingEvidence,
  type RoundTestingEvidenceInput,
  type RoundTrigger,
  type StepRoundSummary,
  currentFindings,
  findingId,
  findingLifecycle,
  hasPriorRounds,
  hasTestingEvidence,
  isFixAttemptRound,
  makeFinding,
  normalizeTestingEvidence,
  parseAgentFindingsOutput,
  renderFindingForPr,
  renderFindingForPrText,
  renderPipelineSummaryForPr,
  renderRoundNarrativeForPr,
  renderRoundsForAgentPrompt,
  renderRoundsForPr,
  renderUnresolvedFindingsForPr,
  summarizeStepRounds,
  unresolvedFindings,
} from "./round.ts";
export {
  executeRoundLoop,
  type RoundCheckInput,
  type RoundCheckResult,
  type RoundCommitInput,
  type RoundCommitProgress,
  type RoundCommitResult,
  type RoundFixInput,
  type RoundFixProgress,
  type RoundFixResult,
  type RoundLoopOptions,
  type RoundLoopResult,
  type RoundStopPolicyInput,
} from "./round-executor.ts";
export { defineStep, type Step, type StepDisplay, type StepResult, type StepRun } from "./step.ts";
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
export type { PipelineStep, RunEvent, RunEventInput } from "./events.ts";
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
export {
  createWorktree,
  currentWorkspaceSourceBranch,
  releaseSourceBranchForWorktree,
  removeWorktree,
  type SourceBranchRelease,
} from "./workspace.ts";
export { AssemblyError, isolationBoundaryFor, validatePipeline } from "./validate.ts";
export type { IsolationBoundary } from "./validate.ts";
