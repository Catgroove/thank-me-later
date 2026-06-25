// A reusable fresh-round loop for Steps. The caller supplies the check and fix work; this module
// owns the round control flow: check, select auto-fix findings, fix once, commit, verify, and
// repeat until the work is clean or stops. The loop is bounded by an attempt cap and by a no-progress
// signal when a fix attempt produces no commit; cross-round finding ids are not used for control.
// When a stop needs a human decision and the Step names itself (`stepName`), the findings are routed
// through `ctx.approveFindings`: an approve or skip ends the loop with a recorded decision, a fix
// continues the loop with the operator's selection and notes, and an abort throws.

import {
  type ApprovalDecision,
  type RoundApproveFindingsInput,
  type RoundLoopStopReason,
  requiresApproval,
} from "./approval.ts";
import type { Ctx } from "./context.ts";
import {
  type Finding,
  type RoundRecordInput,
  type RoundTestingEvidence,
  type RoundTrigger,
  normalizeTestingEvidence,
  renderRoundsForAgentPrompt,
} from "./round.ts";

const DEFAULT_MAX_AUTO_FIX_ATTEMPTS = 3;

export interface RoundCheckInput {
  /** `initial` for the first check, then `verify` after a fix commit. */
  readonly trigger: Extract<RoundTrigger, "initial" | "verify">;
  /** Number of fix commits already attempted in this loop. */
  readonly attempt: number;
  /** Completed rounds in this loop, suitable for fresh-agent prompts. */
  readonly history: readonly RoundRecordInput[];
  /** Markdown rendering of `history`, ready to include in a fresh-agent prompt. */
  readonly historyText: string;
}

export interface RoundCheckResult {
  readonly findings: readonly Finding[];
  readonly testing?: RoundTestingEvidence;
}

export interface RoundFixInput {
  /** 1-based fix attempt number. */
  readonly attempt: number;
  /** Findings selected for this fix round. */
  readonly findings: readonly Finding[];
  /** Completed rounds before this fix, including the check round that selected these findings. */
  readonly history: readonly RoundRecordInput[];
  /** Markdown rendering of `history`, ready to include in a fresh-agent prompt. */
  readonly historyText: string;
}

export interface RoundFixResult {
  readonly summary: string;
}

export type RoundCommitProgress = "progressed" | "no_progress";
export type RoundFixProgress = RoundCommitProgress | "untracked";

export interface RoundCommitInput {
  readonly ctx: Ctx;
  readonly fix: RoundFixInput;
  readonly result: RoundFixResult;
  readonly message?: string;
}

export type RoundCommitResult =
  | { readonly progress: "progressed"; readonly commitSha?: string }
  | { readonly progress: "no_progress"; readonly commitSha?: never };

type CommitFixResult =
  | RoundCommitResult
  | { readonly progress: "untracked"; readonly commitSha?: never };

export interface RoundStopPolicyInput {
  readonly check: RoundCheckInput;
  readonly findings: readonly Finding[];
  readonly selectedFindings: readonly Finding[];
  readonly rounds: readonly RoundRecordInput[];
  readonly attempts: number;
  readonly lastFixProgress?: RoundFixProgress;
}

export interface RoundLoopOptions {
  /** Run one fresh check or verification round. */
  check(input: RoundCheckInput): Promise<RoundCheckResult>;
  /** Run one fresh fix round for the selected findings. */
  fix(input: RoundFixInput): Promise<RoundFixResult>;
  /** Names the Step in approval prompts. When set, stops that need a user run `ctx.approveFindings`. */
  stepName?: string;
  /** Maximum number of fix rounds. Defaults to 3. */
  maxAutoFixAttempts?: number;
  /** Optional stop policy after each check round. Defaults to clean and no-selected stops. */
  stopPolicy?(input: RoundStopPolicyInput): RoundLoopStopReason | undefined;
  /** Commit subject for each fix round when using the default commit behavior. */
  commitMessage?: string | ((input: RoundFixInput, result: RoundFixResult) => string);
  /** Persist and emit rounds as soon as they complete instead of waiting for Step completion. */
  recordRounds?: "deferred" | "live";
  /** Defaults to stage-all and commit. Set false for no commit, or provide custom behavior. */
  commit?: false | ((input: RoundCommitInput) => Promise<RoundCommitResult>);
  /** Defaults to all `auto-fix` findings. */
  selectFindings?(findings: readonly Finding[], input: RoundCheckInput): readonly Finding[];
  /** Defaults to `ask-user` findings. */
  needsUser?(finding: Finding): boolean;
}

export interface RoundLoopResult {
  readonly stopReason: RoundLoopStopReason;
  readonly findings: readonly Finding[];
  readonly rounds: readonly RoundRecordInput[];
  readonly attempts: number;
}

/**
 * Execute a structured fresh-agent loop. Each callback invocation is one round; the callbacks can
 * call `ctx.agent.run`, and the harness contract keeps those invocations isolated. The returned
 * rounds are ready to return from a Step so the engine can persist them to the journal.
 */
export async function executeRoundLoop(
  ctx: Ctx,
  options: RoundLoopOptions,
): Promise<RoundLoopResult> {
  const rounds: RoundRecordInput[] = [];
  const maxAutoFixAttempts = options.maxAutoFixAttempts ?? DEFAULT_MAX_AUTO_FIX_ATTEMPTS;
  if (!Number.isInteger(maxAutoFixAttempts) || maxAutoFixAttempts < 0) {
    throw new Error("round executor: maxAutoFixAttempts must be a non-negative integer");
  }
  let attempts = 0;
  let trigger: Extract<RoundTrigger, "initial" | "verify"> = "initial";
  let lastFixProgress: RoundFixProgress | undefined;

  while (true) {
    const checkInput: RoundCheckInput = {
      trigger,
      attempt: attempts,
      history: [...rounds],
      historyText: renderRoundsForAgentPrompt(rounds),
    };
    const check = await options.check(checkInput);
    const findings = [...check.findings];
    const selected = selectFindings(options, findings, checkInput);
    const testing = normalizeTestingEvidence(check.testing);

    await appendRound(ctx, options, rounds, {
      trigger,
      findings,
      ...(selected.length > 0 ? { selectedFindingIds: selected.map((f) => f.id) } : {}),
      ...(testing ? { testing } : {}),
    });

    let stopReason = stopPolicy(options, {
      check: checkInput,
      findings,
      selectedFindings: selected,
      rounds: [...rounds],
      attempts,
      lastFixProgress,
    });
    if (stopReason === undefined && attempts >= maxAutoFixAttempts) {
      stopReason = "auto_fix_limit_hit";
    }

    if (stopReason === undefined) {
      attempts += 1;
      lastFixProgress = await applyFix(ctx, options, {
        trigger: "auto_fix",
        attempt: attempts,
        fixFindings: selected,
        recordFindings: selected,
        rounds,
      });
      trigger = "verify";
      continue;
    }

    if (options.stepName === undefined || !requiresApproval(stopReason)) {
      return done(stopReason, findings, rounds, attempts);
    }

    const suggestedFindingIds = currentSelectedFindingIds(findings, rounds);
    const approvalInput: RoundApproveFindingsInput = {
      prompt: defaultPrompt(options.stepName, stopReason),
      stopReason,
      findings,
      ...(suggestedFindingIds ? { suggestedFindingIds } : {}),
      context: renderRoundsForAgentPrompt(rounds),
      fixBudget: {
        attempts,
        maxAttempts: maxAutoFixAttempts,
        remainingAttempts: Math.max(0, maxAutoFixAttempts - attempts),
      },
    };
    const decision = await ctx.approveFindings(approvalInput);

    if (decision.action === "abort") {
      throw new Error(decision.reason ?? "approval aborted by operator");
    }
    if (decision.action === "approve" || decision.action === "skip") {
      await appendRound(ctx, options, rounds, approvalRound(findings, decision));
      return done(stopReason, findings, rounds, attempts);
    }

    const decisionFindings = selectDecisionFindings(findings, decision.selectedFindingIds);
    if (decisionFindings.length === 0) {
      throw new Error(`${options.stepName}: approval fix selected no current findings`);
    }
    const userFindings = decision.userFindings ?? [];
    await appendRound(ctx, options, rounds, approvalRound(findings, decision));
    attempts += 1;
    lastFixProgress = await applyFix(ctx, options, {
      trigger: "user_fix",
      attempt: attempts,
      fixFindings: [...annotateWithNotes(decisionFindings, decision.notes), ...userFindings],
      recordFindings: [...decisionFindings, ...userFindings],
      rounds,
      userNotes: cleanNotes(decision.notes),
    });
    trigger = "verify";
  }
}

interface ApplyFixArgs {
  readonly trigger: Extract<RoundTrigger, "auto_fix" | "user_fix">;
  readonly attempt: number;
  /** Findings handed to the fix callback; may carry inline operator notes. */
  readonly fixFindings: readonly Finding[];
  /** Findings recorded in the round; the clean, note-free set. */
  readonly recordFindings: readonly Finding[];
  readonly rounds: RoundRecordInput[];
  readonly userNotes?: Record<string, string>;
}

async function applyFix(
  ctx: Ctx,
  options: RoundLoopOptions,
  args: ApplyFixArgs,
): Promise<RoundFixProgress> {
  const fixInput: RoundFixInput = {
    attempt: args.attempt,
    findings: [...args.fixFindings],
    history: [...args.rounds],
    historyText: renderRoundsForAgentPrompt(args.rounds),
  };
  const fix = await options.fix(fixInput);
  const commit = await commitFix(ctx, options, fixInput, fix);
  const fixSummary = fix.summary.trim();

  await appendRound(ctx, options, args.rounds, {
    trigger: args.trigger,
    findings: [...args.recordFindings],
    selectedFindingIds: args.recordFindings.map((f) => f.id),
    ...(args.userNotes ? { userNotes: args.userNotes } : {}),
    ...(fixSummary.length > 0 ? { fixSummary } : {}),
    ...(commit.commitSha !== undefined ? { commitSha: commit.commitSha } : {}),
  });
  return commit.progress;
}

async function appendRound(
  ctx: Ctx,
  options: RoundLoopOptions,
  rounds: RoundRecordInput[],
  round: RoundRecordInput,
): Promise<void> {
  rounds.push(round);
  if (options.recordRounds === "live") await ctx.recordRound(round);
}

function selectFindings(
  options: RoundLoopOptions,
  findings: readonly Finding[],
  input: RoundCheckInput,
): readonly Finding[] {
  return options.selectFindings
    ? options.selectFindings(findings, input)
    : findings.filter((f) => f.action === "auto-fix");
}

function needsUser(options: RoundLoopOptions, finding: Finding): boolean {
  return options.needsUser ? options.needsUser(finding) : finding.action === "ask-user";
}

function stopPolicy(
  options: RoundLoopOptions,
  input: RoundStopPolicyInput,
): RoundLoopStopReason | undefined {
  const custom = options.stopPolicy?.(input);
  if (custom !== undefined) return custom;
  if (input.findings.length === 0) return "clean";
  if (input.lastFixProgress === "no_progress") return "no_progress";
  if (input.selectedFindings.length > 0) return undefined;
  return input.findings.some((f) => needsUser(options, f)) ? "needs_user" : "remaining_findings";
}

function defaultPrompt(stepName: string, stopReason: RoundLoopStopReason): string {
  if (stopReason === "needs_user") return `${stepName} has findings that need a user decision`;
  if (stopReason === "auto_fix_limit_hit") return `${stepName} hit the auto-fix limit`;
  if (stopReason === "no_progress") return `${stepName} fix attempt produced no commit`;
  return `${stepName} has unresolved findings`;
}

function currentSelectedFindingIds(
  findings: readonly Finding[],
  rounds: readonly RoundRecordInput[],
): readonly string[] | undefined {
  const selected = rounds.at(-1)?.selectedFindingIds;
  if (selected === undefined || selected.length === 0) return undefined;
  const current = new Set(findings.map((finding) => finding.id));
  const ids = selected.filter((id) => current.has(id));
  return ids.length > 0 ? ids : undefined;
}

function approvalRound(findings: readonly Finding[], decision: ApprovalDecision): RoundRecordInput {
  const userFindings = decision.userFindings ?? [];
  const userNotes = cleanNotes(decision.notes);
  const resolution =
    decision.action === "fix" ? undefined : decision.action === "skip" ? "skipped" : "approved";
  return {
    trigger: "approval",
    findings: [...findings, ...userFindings],
    ...(decision.action === "fix" ? { selectedFindingIds: [...decision.selectedFindingIds] } : {}),
    ...(userNotes ? { userNotes } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

function cleanNotes(
  notes: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (notes === undefined) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [id, note] of Object.entries(notes)) {
    const trimmed = note.trim();
    if (trimmed.length > 0) cleaned[id] = trimmed;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function selectDecisionFindings(
  findings: readonly Finding[],
  selectedFindingIds: readonly string[],
): Finding[] {
  const selected = new Set(selectedFindingIds);
  return findings.filter((finding) => selected.has(finding.id));
}

function annotateWithNotes(
  findings: readonly Finding[],
  notes: Readonly<Record<string, string>> | undefined,
): Finding[] {
  return findings.map((finding) => {
    const note = notes?.[finding.id]?.trim();
    if (!note) return finding;
    return { ...finding, detail: `${finding.detail}\n\nOperator note: ${note}` };
  });
}

async function commitFix(
  ctx: Ctx,
  options: RoundLoopOptions,
  input: RoundFixInput,
  result: RoundFixResult,
): Promise<CommitFixResult> {
  if (options.commit === false) return { progress: "untracked" };

  const message = commitMessage(options, input, result);
  if (options.commit !== undefined) {
    const commit = await options.commit({ ctx, fix: input, result, message });
    assertCommitResult(commit);
    return commit;
  }

  const subject = message?.trim() ?? "";
  if (subject.length === 0) throw new Error("round executor: fix commit message must not be empty");

  await ctx.git.stageAll();
  const { staged } = await ctx.git.status();
  if (staged.length === 0) {
    ctx.log("round executor: fix produced no commit");
    return { progress: "no_progress" };
  }
  const commit = await ctx.git.commit(subject);
  return { progress: "progressed", commitSha: commit.sha };
}

function assertCommitResult(commit: RoundCommitResult): void {
  if (commit.progress !== "progressed" && commit.progress !== "no_progress") {
    throw new Error(
      'round executor: custom commit must return progress "progressed" or "no_progress"',
    );
  }
  if (commit.progress === "no_progress" && commit.commitSha !== undefined) {
    throw new Error(
      'round executor: custom commit must not return commitSha when progress is "no_progress"',
    );
  }
}

function commitMessage(
  options: RoundLoopOptions,
  input: RoundFixInput,
  result: RoundFixResult,
): string | undefined {
  return typeof options.commitMessage === "string"
    ? options.commitMessage
    : options.commitMessage?.(input, result);
}

function done(
  stopReason: RoundLoopStopReason,
  findings: readonly Finding[],
  rounds: readonly RoundRecordInput[],
  attempts: number,
): RoundLoopResult {
  return { stopReason, findings, rounds, attempts };
}
