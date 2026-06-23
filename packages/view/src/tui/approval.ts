// Pure helpers for the single-select findings-approval menu. The drawer presents one decision -
// Fix / Approve / Skip / Abort - as a highlighted vertical list; these helpers decide which actions
// to offer, what a chosen action resolves to, and the one-line severity summary shown above it.
// Per-finding selection lives in the inspector's Findings tab, not in the gate: `Fix` sends back the
// suggested set (or every finding when none was suggested), so the decision stays a single choice.

import type { ApprovalDecision, ApproveFindingsInput, Finding } from "@tml/core";

export type ApprovalAction = "fix" | "approve" | "skip" | "abort";

export interface ActionOption {
  readonly action: ApprovalAction;
  /** Menu label. */
  readonly label: string;
  /** Direct-shortcut key. */
  readonly key: string;
}

const OPTIONS: readonly ActionOption[] = [
  { action: "fix", label: "Fix findings", key: "f" },
  { action: "approve", label: "Approve as-is", key: "a" },
  { action: "skip", label: "Skip this step", key: "s" },
  { action: "abort", label: "Abort the run", key: "x" },
];

/** Actions offered for an approval: `fix` only when there are findings to send back. */
export function actionOptions(input: ApproveFindingsInput): readonly ActionOption[] {
  return input.findings.length > 0 ? OPTIONS : OPTIONS.filter((option) => option.action !== "fix");
}

/** Findings a `fix` sends back: the suggested selection, or every finding when none was suggested. */
export function fixSelection(input: ApproveFindingsInput): readonly string[] {
  const suggested = input.selectedFindingIds ?? [];
  return suggested.length > 0 ? suggested : input.findings.map((finding) => finding.id);
}

/** Build the decision for a chosen action. `fix` with no findings is a no-op (returns undefined). */
export function buildDecision(
  action: ApprovalAction,
  input: ApproveFindingsInput,
): ApprovalDecision | undefined {
  switch (action) {
    case "approve":
      return { action: "approve" };
    case "skip":
      return { action: "skip" };
    case "abort":
      return { action: "abort" };
    case "fix": {
      const ids = [...fixSelection(input)];
      return ids.length > 0 ? { action: "fix", selectedFindingIds: ids } : undefined;
    }
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * One-line severity tally for the drawer header, e.g. "2 errors · 1 warning · 3 findings". The total
 * is dropped when a single severity bucket already conveys it (so "3 errors", not "3 errors · 3
 * findings"). Full per-finding detail lives in the inspector's Findings tab, never here.
 */
export function summaryLine(findings: readonly Finding[]): string {
  if (findings.length === 0) return "No findings.";
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const finding of findings) {
    if (finding.severity === "error") errors += 1;
    else if (finding.severity === "warning") warnings += 1;
    else infos += 1;
  }
  const parts: string[] = [];
  if (errors > 0) parts.push(plural(errors, "error"));
  if (warnings > 0) parts.push(plural(warnings, "warning"));
  if (infos > 0) parts.push(plural(infos, "info"));
  if (parts.length !== 1) parts.push(plural(findings.length, "finding"));
  return parts.join(" · ");
}
