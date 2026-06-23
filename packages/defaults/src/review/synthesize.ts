// The structured side of review: a throw-on-mismatch parser for the pass reply (the agent returns
// JSON against `findingsSchema`), and the pure synthesis of the review result into the single
// `reviewSummary` markdown. Risk is computed here, in code - the agent never sets the overall
// risk. No `ctx`, so all of this is unit-testable in isolation.

import { parseAgentFindingsOutput, type Finding, renderFindingForPr } from "@tml/core";

export type { Finding };
export type Risk = "low" | "medium" | "high";

/** Validate the review pass's structured reply into core Findings, throwing on anything malformed. */
export function parseReviewFindings(output: unknown): Finding[] {
  return parseAgentFindingsOutput(output, {
    namespace: "review",
    sourceName: "review",
    enforceActionForDisposition: true,
  });
}

/** Strongest disposition wins. */
export function riskOf(findings: readonly Finding[]): Risk {
  if (findings.some((f) => f.disposition === "blocker")) return "high";
  if (findings.some((f) => f.disposition === "should-fix")) return "medium";
  return "low";
}

/** Fold the findings into the `reviewSummary` markdown. Above the fold: risk, a one-line tally,
 *  and the fixes applied. The full review breakdown is tucked into a collapsible `<details>` so
 *  the PR body stays scannable. Deterministic. */
export function summarize(findings: readonly Finding[], fixSummary: string): string {
  const fixes = fixSummary.trim();
  const unresolvedAutoFix = findings.filter((f) => f.action === "auto-fix").length;
  const decide = findings.filter((f) => f.action === "ask-user").length;
  const info = findings.filter((f) => f.action === "no-op").length;

  const head: string[] = [`**Risk: ${riskOf(findings)}**`, ""];

  const tally = [
    unresolvedAutoFix > 0
      ? `${unresolvedAutoFix} ${unresolvedAutoFix === 1 ? "still needs" : "still need"} an auto-fix`
      : null,
    decide > 0 ? `${decide} ${decide === 1 ? "needs" : "need"} your decision` : null,
    info > 0 ? `${info} informational` : null,
  ].filter((s): s is string => s !== null);
  if (tally.length > 0) head.push(tally.join(" · "), "");
  if (fixes.length > 0) head.push(`**Fixes applied:** ${fixes}`, "");

  const lines = [...head];
  if (findings.length > 0) {
    lines.push(
      "<details>",
      "<summary>Full review</summary>",
      "",
      ...findings.map(renderFindingForPr),
      "",
      "</details>",
    );
  } else {
    lines.push("No findings.");
  }
  return lines.join("\n").trim();
}
