import type { ApprovalDecision, ApproveFindingsInput } from "./approval.ts";
import type { Finding } from "./round.ts";

const REQUIRED_DISPOSITIONS = new Set<Finding["disposition"]>(["blocker", "should-fix"]);
const ROUND_LOOP_STOP_REASONS: ReadonlySet<string> = new Set([
  "clean",
  "needs_user",
  "auto_fix_limit_hit",
  "no_progress",
  "remaining_findings",
]);

export type RoundLoopStopReason =
  | "clean"
  | "needs_user"
  | "auto_fix_limit_hit"
  | "no_progress"
  | "remaining_findings";

export interface RoundApprovalFixBudget {
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly remainingAttempts: number;
}

export interface RoundApproveFindingsInput extends ApproveFindingsInput {
  readonly stopReason: RoundLoopStopReason;
  readonly fixBudget?: RoundApprovalFixBudget;
}

export type ApprovalFindingsInput = ApproveFindingsInput | RoundApproveFindingsInput;

export function isRoundApproveFindingsInput(
  input: ApprovalFindingsInput,
): input is RoundApproveFindingsInput {
  const stopReason = (input as { readonly stopReason?: unknown }).stopReason;
  return typeof stopReason === "string" && ROUND_LOOP_STOP_REASONS.has(stopReason);
}

export function autoApproveResponder(): (input: ApprovalFindingsInput) => Promise<ApprovalDecision> {
  return (input) => Promise.resolve(autoApproveFindings(input));
}

export function autoApproveFindings(input: ApprovalFindingsInput): ApprovalDecision {
  const stopReason = isRoundApproveFindingsInput(input) ? input.stopReason : undefined;

  if (stopReason === "needs_user") {
    if (isRoundApproveFindingsInput(input) && input.fixBudget?.remainingAttempts === 0) {
      return approveOptionalOrAbort(input, "auto_fix_limit_hit");
    }
    const selectedFindingIds = input.findings
      .filter((finding) => finding.action === "ask-user")
      .map((finding) => finding.id);
    if (selectedFindingIds.length > 0) return { action: "fix", selectedFindingIds };
    return approveOptionalOrAbort(input, stopReason);
  }

  if (stopReason === "clean") return { action: "approve" };
  return approveOptionalOrAbort(input, stopReason);
}

function approveOptionalOrAbort(
  input: ApprovalFindingsInput,
  stopReason: RoundLoopStopReason | undefined,
): ApprovalDecision {
  const required = input.findings.filter((finding) =>
    REQUIRED_DISPOSITIONS.has(finding.disposition),
  );
  if (required.length === 0) return { action: "approve" };
  const where = stopReason === undefined ? "" : ` at ${stopReason}`;
  return {
    action: "abort",
    reason: `auto approval stopped${where}: unresolved ${describeFindings(required)}`,
  };
}

function describeFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${finding.disposition} "${finding.title}" (${finding.id})`)
    .join(", ");
}
