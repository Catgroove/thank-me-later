import {
  executeRoundLoop,
  renderFindingForPr,
  type ApprovalDecision,
  type Ctx,
  type Finding,
  type RoundLoopOptions,
  type RoundLoopResult,
  type RoundLoopStopReason,
  type RoundRecordInput,
} from "@tml/core";

export interface ApprovalRoundLoopOptions extends RoundLoopOptions {
  readonly stepName: string;
}

export async function executeRoundLoopWithApproval(
  ctx: Ctx,
  options: ApprovalRoundLoopOptions,
): Promise<RoundLoopResult> {
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
      prompt: defaultPrompt(options.stepName, result.stopReason),
      findings: result.findings,
      selectedFindingIds: currentSelectedFindingIds(result.findings, result.rounds),
      context: renderRoundContext(result.rounds),
    });

    if (decision.action === "abort") throw new Error("approval aborted by operator");

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
    initialFixFindings = findingsForDecisionFix(selected, decision);
    pendingUserFix = { roundIndex: result.rounds.length, decision };
  }
}

function requiresApproval(stopReason: RoundLoopStopReason): boolean {
  return stopReason === "needs_user" || stopReason === "auto_fix_limit_hit";
}

function defaultPrompt(stepName: string, stopReason: RoundLoopStopReason): string {
  if (stopReason === "needs_user") return `${stepName} has findings that need a user decision`;
  if (stopReason === "auto_fix_limit_hit") return `${stepName} hit the auto-fix limit`;
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

function findingsForDecisionFix(
  selected: readonly Finding[],
  decision: ApprovalDecision,
): readonly Finding[] {
  const notes = decision.notes ?? {};
  const annotated = selected.map((finding) => {
    const note = notes[finding.id]?.trim();
    if (!note) return finding;
    return { ...finding, detail: `${finding.detail}\n\nOperator note: ${note}` };
  });
  return [...annotated, ...(decision.userFindings ?? [])];
}

function mergeDecisionIntoUserFixRound(
  index: number,
  rounds: readonly RoundRecordInput[],
  decision: ApprovalDecision,
): readonly RoundRecordInput[] {
  const userNotes = cleanNotes(decision.notes);
  if (userNotes === undefined) return rounds;

  return rounds.map((round, i) => {
    if (i !== index) return round;
    return {
      ...round,
      findings: round.findings.map((finding) => stripDecisionNote(finding, decision.notes)),
      userNotes,
    };
  });
}

function stripDecisionNote(
  finding: Finding,
  notes: Readonly<Record<string, string>> | undefined,
): Finding {
  const note = notes?.[finding.id]?.trim();
  if (!note) return finding;
  const suffix = `\n\nOperator note: ${note}`;
  if (!finding.detail.endsWith(suffix)) return finding;
  return { ...finding, detail: finding.detail.slice(0, -suffix.length) };
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
