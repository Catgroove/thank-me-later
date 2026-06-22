import {
  cancel,
  executeRoundLoop,
  renderFindingForPr,
  type ApprovalDecision,
  type Ctx,
  type Finding,
  type FlowSignal,
  type RoundLoopOptions,
  type RoundLoopResult,
  type RoundLoopStopReason,
  type RoundRecordInput,
} from "@tml/core";

export interface ApprovalRoundLoopOptions extends RoundLoopOptions {
  readonly stepName: string;
  readonly prompt?: (result: RoundLoopResult) => string;
  readonly context?: (result: RoundLoopResult) => string | undefined;
}

export type ApprovalRoundLoopResult = RoundLoopResult | FlowSignal;

export async function executeRoundLoopWithApproval(
  ctx: Ctx,
  options: ApprovalRoundLoopOptions,
): Promise<ApprovalRoundLoopResult> {
  let initialRounds: readonly RoundRecordInput[] | undefined;
  let initialAttempts: number | undefined;
  let initialFixFindings: readonly Finding[] | undefined;
  let pendingUserFix:
    | { readonly roundIndex: number; readonly decision: ApprovalDecision }
    | undefined;

  while (true) {
    const loopResult = await executeRoundLoop(ctx, {
      ...options,
      ...(initialRounds ? { initialRounds } : {}),
      ...(initialAttempts !== undefined ? { initialAttempts } : {}),
      ...(initialFixFindings ? { initialFixFindings } : {}),
    });
    const result = pendingUserFix
      ? {
          ...loopResult,
          rounds: mergeDecisionIntoUserFixRound(
            pendingUserFix.roundIndex,
            loopResult.rounds,
            pendingUserFix.decision,
          ),
        }
      : loopResult;
    initialRounds = undefined;
    initialAttempts = undefined;
    initialFixFindings = undefined;
    pendingUserFix = undefined;

    if (!requiresApproval(result.stopReason)) return result;

    const decision = await ctx.approveFindings({
      prompt: options.prompt?.(result) ?? defaultPrompt(options.stepName, result.stopReason),
      findings: result.findings,
      selectedFindingIds: latestSelectedFindingIds(result.rounds),
      context: options.context?.(result) ?? renderRoundContext(result.rounds),
    });

    if (decision.action === "abort") return cancel("approval aborted by operator");

    if (decision.action === "approve" || decision.action === "skip") {
      return {
        ...result,
        rounds: [...result.rounds, approvalRound(result.findings, decision)],
      };
    }

    const selected = selectDecisionFindings(result.findings, decision.selectedFindingIds);
    if (selected.length === 0) {
      throw new Error(`${options.stepName}: approval fix selected no current findings`);
    }

    initialRounds = result.rounds;
    initialAttempts = result.attempts;
    initialFixFindings = selected;
    pendingUserFix = { roundIndex: result.rounds.length, decision };
  }
}

function requiresApproval(stopReason: RoundLoopStopReason): boolean {
  return stopReason !== "clean";
}

function defaultPrompt(stepName: string, stopReason: RoundLoopStopReason): string {
  if (stopReason === "needs_user") return `${stepName} has findings that need a user decision`;
  if (stopReason === "auto_fix_limit_hit") return `${stepName} hit the auto-fix limit`;
  return `${stepName} has unresolved findings`;
}

function latestSelectedFindingIds(
  rounds: readonly RoundRecordInput[],
): readonly string[] | undefined {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const selected = rounds[i]?.selectedFindingIds;
    if (selected !== undefined && selected.length > 0) return selected;
  }
  return undefined;
}

function approvalRound(findings: readonly Finding[], decision: ApprovalDecision): RoundRecordInput {
  const userFindings = decision.userFindings ?? [];
  const userNotes = cleanNotes(decision.notes);
  const action = decision.action === "skip" ? "skipped" : "approved";
  return {
    trigger: "user_fix",
    findings: [...findings, ...userFindings],
    ...(userNotes ? { userNotes } : {}),
    fixSummary: `Operator ${action} unresolved findings.`,
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

function mergeDecisionIntoUserFixRound(
  index: number,
  rounds: readonly RoundRecordInput[],
  decision: ApprovalDecision,
): readonly RoundRecordInput[] {
  const userFindings = decision.userFindings ?? [];
  const userNotes = cleanNotes(decision.notes);
  if (userFindings.length === 0 && userNotes === undefined) return rounds;

  return rounds.map((round, i) => {
    if (i !== index) return round;
    return {
      ...round,
      findings: [...round.findings, ...userFindings],
      ...(userNotes ? { userNotes } : {}),
    };
  });
}

function renderRoundContext(rounds: readonly RoundRecordInput[]): string {
  if (rounds.length === 0) return "No prior rounds.";
  return rounds
    .map((round, index) => {
      const lines = [`Round ${index}: ${round.trigger}`];
      if (round.findings.length === 0) lines.push("No findings.");
      else lines.push(...round.findings.map(renderFindingForPr));
      if (round.selectedFindingIds && round.selectedFindingIds.length > 0) {
        lines.push(`Selected: ${round.selectedFindingIds.join(", ")}`);
      }
      if (round.userNotes && Object.keys(round.userNotes).length > 0) {
        lines.push("User notes:");
        for (const [id, note] of Object.entries(round.userNotes)) lines.push(`- ${id}: ${note}`);
      }
      if (round.fixSummary?.trim()) lines.push(`Fix summary: ${round.fixSummary.trim()}`);
      if (round.commitSha) lines.push(`Commit: ${round.commitSha}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
