import type { ApprovalDecision, ApproveFindingsInput, Finding } from "@tml/core";

const REQUIRED_DISPOSITIONS = new Set<Finding["disposition"]>(["blocker", "should-fix"]);

/** Non-interactive approval policy for `tml ship --auto`. */
export function autoApproveResponder(): (input: ApproveFindingsInput) => Promise<ApprovalDecision> {
  return (input) => Promise.resolve(autoApprove(input));
}

function autoApprove(input: ApproveFindingsInput): ApprovalDecision {
  if (input.stopReason === "needs_user") {
    return { action: "fix", selectedFindingIds: input.findings.map((finding) => finding.id) };
  }

  if (input.stopReason === "no_progress" || input.stopReason === "auto_fix_limit_hit") {
    return approveOptionalOrAbort(input);
  }

  if (input.stopReason === "clean") return { action: "approve" };
  return approveOptionalOrAbort(input);
}

function approveOptionalOrAbort(input: ApproveFindingsInput): ApprovalDecision {
  const required = input.findings.filter((finding) =>
    REQUIRED_DISPOSITIONS.has(finding.disposition),
  );
  if (required.length === 0) return { action: "approve" };
  return {
    action: "abort",
    reason: `auto approval stopped at ${input.stopReason}: unresolved ${describeFindings(required)}`,
  };
}

function describeFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${finding.disposition} "${finding.title}" (${finding.id})`)
    .join(", ");
}
