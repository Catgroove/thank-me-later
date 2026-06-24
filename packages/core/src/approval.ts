// Structured approval primitives for finding-based gates. `ctx.ask` remains the
// free-text escape hatch; this module is the reusable contract for approval gates
// that need comparable findings, selected fixes, per-finding notes, and
// user-authored findings without inventing a one-off UI protocol.

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
