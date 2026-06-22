// A reusable fresh-round loop for Steps. The caller supplies the check and fix work; this module
// owns the no-mistakes control flow: check, select auto-fix findings, fix once, commit, verify,
// and repeat until the work is clean or requires a human decision.

import type { Ctx } from "./context.ts";
import {
  type Finding,
  type RoundRecordInput,
  type RoundTrigger,
  renderFindingForPr,
} from "./round.ts";

const MAX_AUTO_FIX_ATTEMPTS = 3;

export type RoundLoopStopReason =
  | "clean"
  | "needs_user"
  | "auto_fix_limit_hit"
  | "remaining_findings";

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

export interface RoundLoopOptions {
  /** Run one fresh check or verification round. */
  check(input: RoundCheckInput): Promise<RoundCheckResult>;
  /** Run one fresh fix round for the selected findings. */
  fix(input: RoundFixInput): Promise<RoundFixResult>;
  /** Commit subject for each fix round. */
  commitMessage: string | ((input: RoundFixInput, result: RoundFixResult) => string);
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
  let attempts = 0;
  let trigger: Extract<RoundTrigger, "initial" | "verify"> = "initial";

  while (true) {
    const checkHistory = [...rounds];
    const checkInput: RoundCheckInput = {
      trigger,
      attempt: attempts,
      history: checkHistory,
      historyText: renderHistory(checkHistory),
    };
    const check = await options.check(checkInput);
    const findings = [...check.findings];
    const selected = selectFindings(options, findings, checkInput);

    rounds.push({
      trigger,
      findings,
      ...(selected.length > 0 ? { selectedFindingIds: selected.map((f) => f.id) } : {}),
    });

    if (findings.length === 0) return done("clean", findings, rounds, attempts);
    if (selected.length === 0) {
      const stopReason = findings.some((f) => needsUser(options, f))
        ? "needs_user"
        : "remaining_findings";
      return done(stopReason, findings, rounds, attempts);
    }
    if (attempts >= MAX_AUTO_FIX_ATTEMPTS) {
      return done("auto_fix_limit_hit", findings, rounds, attempts);
    }

    const fixHistory = [...rounds];
    const fixInput: RoundFixInput = {
      attempt: attempts + 1,
      findings: selected,
      history: fixHistory,
      historyText: renderHistory(fixHistory),
    };
    const fix = await options.fix(fixInput);
    const commitSha = await commitFix(ctx, commitMessage(options, fixInput, fix));
    const fixSummary = fix.summary.trim();

    rounds.push({
      trigger: "auto_fix",
      findings: [...selected],
      selectedFindingIds: selected.map((f) => f.id),
      ...(fixSummary.length > 0 ? { fixSummary } : {}),
      ...(commitSha !== undefined ? { commitSha } : {}),
    });

    attempts += 1;
    trigger = "verify";
  }
}

function renderHistory(rounds: readonly RoundRecordInput[]): string {
  if (rounds.length === 0) return "No prior rounds.";
  return rounds
    .map((round, index) => {
      const lines = [`Round ${index}: ${round.trigger}`];
      if (round.findings.length === 0) lines.push("No findings.");
      else lines.push(...round.findings.map(renderFindingForPr));
      if (round.selectedFindingIds && round.selectedFindingIds.length > 0) {
        lines.push(`Selected: ${round.selectedFindingIds.join(", ")}`);
      }
      if (round.fixSummary?.trim()) lines.push(`Fix summary: ${round.fixSummary.trim()}`);
      if (round.commitSha) lines.push(`Commit: ${round.commitSha}`);
      return lines.join("\n");
    })
    .join("\n\n");
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

async function commitFix(ctx: Ctx, message: string): Promise<string | undefined> {
  const subject = message.trim();
  if (subject.length === 0) throw new Error("round executor: fix commit message must not be empty");

  await ctx.git.stageAll();
  const { staged } = await ctx.git.status();
  if (staged.length === 0) {
    ctx.log("round executor: fix produced no commit");
    return undefined;
  }
  return (await ctx.git.commit(subject)).sha;
}

function commitMessage(
  options: RoundLoopOptions,
  input: RoundFixInput,
  result: RoundFixResult,
): string {
  return typeof options.commitMessage === "string"
    ? options.commitMessage
    : options.commitMessage(input, result);
}

function done(
  stopReason: RoundLoopStopReason,
  findings: readonly Finding[],
  rounds: readonly RoundRecordInput[],
  attempts: number,
): RoundLoopResult {
  return { stopReason, findings, rounds, attempts };
}
