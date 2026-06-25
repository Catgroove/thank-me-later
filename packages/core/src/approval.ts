// The approval gate, top to bottom: the decision the operator returns, the round-loop stop reasons
// that open the gate, and the predicate that decides which stops require a human. `ctx.ask` remains
// the free-text escape hatch; this module is the reusable contract for finding-based gates that need
// comparable findings, selected fixes, per-finding notes, and user-authored findings without a
// one-off UI protocol.

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

interface ApprovalDecisionBase {
  /** Human notes keyed by finding id. */
  readonly notes?: Readonly<Record<string, string>>;
  /** Additional findings authored by the approver. */
  readonly userFindings?: readonly Finding[];
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
