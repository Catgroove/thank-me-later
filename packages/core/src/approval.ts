// Structured approval primitives for finding-based gates. `ctx.ask` remains the
// free-text escape hatch; this module is the reusable contract for approval gates
// that need comparable findings, selected fixes, per-finding notes, and
// user-authored findings without inventing a one-off UI protocol.

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

export interface RoundApproveFindingsInput extends ApproveFindingsInput {
  readonly stopReason: RoundLoopStopReason;
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

export function isRoundApproveFindingsInput(
  input: ApproveFindingsInput,
): input is RoundApproveFindingsInput {
  const stopReason = (input as { readonly stopReason?: unknown }).stopReason;
  return typeof stopReason === "string" && ROUND_LOOP_STOP_REASONS.has(stopReason);
}

export function autoApproveResponder(): (input: ApproveFindingsInput) => Promise<ApprovalDecision> {
  return (input) => Promise.resolve(autoApproveFindings(input));
}

export function autoApproveFindings(input: ApproveFindingsInput): ApprovalDecision {
  const stopReason = isRoundApproveFindingsInput(input) ? input.stopReason : undefined;

  if (stopReason === "needs_user") {
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
  input: ApproveFindingsInput,
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
