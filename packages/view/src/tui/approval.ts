// Pure helpers for the structured findings-approval drawer: the toggleable selection set and turning
// a chosen action + selection into an `ApprovalDecision`. The drawer keys map straight onto these
// (`space` toggle, `a` approve, `f` fix, `s` skip, `x` abort), keeping the component logic thin.

import type { ApprovalDecision, ApproveFindingsInput } from "@tml/core";

/** The initial selection a drawer opens with: the input's suggested fix selection, if any. */
export function initialSelection(input: ApproveFindingsInput): Set<string> {
  return new Set(input.selectedFindingIds ?? []);
}

/** Toggle one finding id in the selection, returning a new set (never mutates the input). */
export function toggleSelection(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export type ApprovalAction = "approve" | "fix" | "skip" | "abort";

/**
 * Build the decision for an action. `fix` carries the current selection; an empty selection makes
 * `fix` a no-op (returns undefined) so the drawer can keep waiting rather than submit an empty fix.
 */
export function buildDecision(
  action: ApprovalAction,
  selection: ReadonlySet<string>,
): ApprovalDecision | undefined {
  switch (action) {
    case "approve":
      return { action: "approve" };
    case "skip":
      return { action: "skip" };
    case "abort":
      return { action: "abort" };
    case "fix": {
      const ids = [...selection];
      return ids.length > 0 ? { action: "fix", selectedFindingIds: ids } : undefined;
    }
  }
}
