// Pure helpers for the structured findings-approval drawer. The drawer has two independent ideas:
// which findings are selected for a fix, and which terminal action resolves the prompt. A `fix`
// decision must use the visible selection the operator can change; suggested ids are only an initial
// default, never a hidden replacement for user intent.

import type { ApprovalDecision, ApproveFindingsInput, Finding } from "@tml/core";

export type ApprovalAction = "fix" | "approve" | "skip" | "abort";

export interface ActionOption {
  readonly action: ApprovalAction;
  /** Menu label. */
  readonly label: string;
  /** Direct-shortcut key. */
  readonly key: string;
}

const TERMINAL_OPTIONS: readonly ActionOption[] = [
  { action: "approve", label: "Approve as-is", key: "a" },
  { action: "skip", label: "Skip this step", key: "s" },
  { action: "abort", label: "Abort the run", key: "x" },
];

export function suggestedSelection(input: ApproveFindingsInput): readonly string[] {
  const known = new Set(input.findings.map((finding) => finding.id));
  return (input.suggestedFindingIds ?? []).filter((id) => known.has(id));
}

/** Actions offered for an approval. `fix` is available only for an explicit visible selection. */
export function actionOptions(selectedFindingIds: readonly string[]): readonly ActionOption[] {
  return selectedFindingIds.length > 0
    ? [
        {
          action: "fix",
          label: `Fix selected findings (${selectedFindingIds.length})`,
          key: "f",
        },
        ...TERMINAL_OPTIONS,
      ]
    : TERMINAL_OPTIONS;
}

/** Build the decision for a chosen action. `fix` with no selected findings is a no-op. */
export function buildDecision(
  action: ApprovalAction,
  selectedFindingIds: readonly string[],
): ApprovalDecision | undefined {
  switch (action) {
    case "approve":
      return { action: "approve" };
    case "skip":
      return { action: "skip" };
    case "abort":
      return { action: "abort" };
    case "fix": {
      const ids = [...selectedFindingIds];
      return ids.length > 0 ? { action: "fix", selectedFindingIds: ids } : undefined;
    }
  }
}

export function toggleSelection(
  selectedFindingIds: readonly string[],
  findingId: string,
): readonly string[] {
  return selectedFindingIds.includes(findingId)
    ? selectedFindingIds.filter((id) => id !== findingId)
    : [...selectedFindingIds, findingId];
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** One-line severity tally for the drawer header. */
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
