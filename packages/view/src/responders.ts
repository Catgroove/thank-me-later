// Shared failing responders for non-interactive modes. When a Run reaches `ctx.ask` or
// `ctx.approveFindings` but the selected renderer cannot prompt (plain/non-TTY, or a renderer that
// supplies no responder), `ship()` wires these in so the Run fails with a clear, actionable message
// instead of bubbling up the engine's internal "not implemented" headless-suspend error.

import type { ApprovalDecision, ApproveFindingsInput } from "@tml/core";

export function failingAskResponder(): (prompt: string) => Promise<string> {
  return () =>
    Promise.reject(
      new Error(
        "tml: this Run needs an interactive Ask; rerun in the TUI or implement a headless Ask policy.",
      ),
    );
}

export function failingApproveResponder(): (
  input: ApproveFindingsInput,
) => Promise<ApprovalDecision> {
  return () =>
    Promise.reject(
      new Error(
        "tml: this Run needs an interactive findings approval; rerun in the TUI or implement a headless approval policy.",
      ),
    );
}
