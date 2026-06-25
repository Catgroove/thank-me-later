// The approval gate, top to bottom: the decision the operator (or an auto-policy) returns, the
// round-loop stop reasons that open the gate, the predicate that decides which stops require a
// human, and the default non-interactive policy. `ctx.ask` remains the free-text escape hatch;
// this module is the reusable contract for finding-based gates that need comparable findings,
// selected fixes, per-finding notes, and user-authored findings without a one-off UI protocol.

import type { Finding } from "./round.ts";

export interface ApproveFindingsInput {
  /** Human prompt shown above the structured findings. */
  readonly prompt: string;
  /** Findings awaiting a decision. */
  readonly findings: readonly Finding[];
  /** Optional suggested selection, usually the auto-fixable findings. The UI may change it. */
  readonly suggestedFindingIds?: readonly string[];
  /** Optional context such as previous round history or policy notes. */
  readonly context?: string;
}

export type ApprovalDecisionSource = "operator" | "auto";

interface ApprovalDecisionBase {
  /** Human notes keyed by finding id. */
  readonly notes?: Readonly<Record<string, string>>;
  /** Additional findings authored by the approver. */
  readonly userFindings?: readonly Finding[];
  /** Who supplied this decision. Omitted means a human operator. */
  readonly source?: ApprovalDecisionSource;
}

export interface ApproveDecision extends ApprovalDecisionBase {
  readonly action: "approve";
}

export interface FixDecision extends ApprovalDecisionBase {
  readonly action: "fix";
  readonly selectedFindingIds: readonly string[];
}

export interface SkipDecision extends ApprovalDecisionBase {
  readonly action: "skip";
}

export interface AbortDecision extends ApprovalDecisionBase {
  readonly action: "abort";
  /** Optional abort explanation surfaced by non-interactive policies. */
  readonly reason?: string;
}

export type ApprovalDecision = ApproveDecision | FixDecision | SkipDecision | AbortDecision;

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

/** Which round-loop stops hand off to a human decision rather than ending the loop on their own. */
export function requiresApproval(stopReason: RoundLoopStopReason): boolean {
  return (
    stopReason === "needs_user" ||
    stopReason === "auto_fix_limit_hit" ||
    stopReason === "no_progress"
  );
}

export function autoApproveResponder(): (
  input: ApprovalFindingsInput,
) => Promise<ApprovalDecision> {
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
    if (selectedFindingIds.length > 0) return { action: "fix", selectedFindingIds, source: "auto" };
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
  if (required.length === 0) return { action: "approve", source: "auto" };
  const where = stopReason === undefined ? "" : ` at ${stopReason}`;
  return {
    action: "abort",
    source: "auto",
    reason: `auto approval stopped${where}: unresolved ${describeFindings(required)}`,
  };
}

function describeFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${finding.disposition} "${finding.title}" (${finding.id})`)
    .join(", ");
}
