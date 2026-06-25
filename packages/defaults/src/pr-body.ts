// Deterministic PR-body policy for the default pipeline. The generated block owns tml's audit
// surface, including the agent-authored description. On re-runs, tml refreshes only the marked
// block so human edits around it survive. The block is not a PR comment or review thread.

import {
  currentFindings,
  renderPipelineSummaryForPr,
  renderUnresolvedFindingsForPr,
  summarizeStepRounds,
  type RoundRecord,
} from "@tml/core";

const START = "<!-- tml:summary:start -->";
const END = "<!-- tml:summary:end -->";

export interface DefaultPrBodyInput {
  readonly description: string;
  readonly reviewSummary: string;
  readonly rounds: readonly RoundRecord[];
}

export function buildDefaultPrBody(input: DefaultPrBodyInput): string {
  return generatedBlock(input);
}

export function updateDefaultPrBody(existingBody: string, input: DefaultPrBodyInput): string {
  const block = generatedBlock(input);
  const existing = existingBody.trim();
  if (existing.length === 0) return buildDefaultPrBody(input);

  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start >= 0 && end > start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + END.length).trimStart();
    return [before, block, after].filter((part) => part.length > 0).join("\n\n");
  }

  return `${existing}\n\n${block}`;
}

function generatedBlock(input: DefaultPrBodyInput): string {
  const unresolved = currentFindings(input.rounds);
  return [
    START,
    "## Intent",
    cleanDescription(input.description),
    "",
    "## What changed",
    "See the branch diff and commits for the concrete changes.",
    "",
    "## Risk assessment",
    riskAssessment(unresolved, input.reviewSummary),
    "",
    "## Testing",
    testingSummary(input.rounds),
    "",
    "## Pipeline summary",
    renderPipelineSummaryForPr(input.rounds),
    "",
    "## Unresolved findings",
    renderUnresolvedFindingsForPr(input.rounds),
    END,
  ].join("\n");
}

function cleanDescription(description: string): string {
  const body = description.trim();
  return body.length > 0 ? body : "No generated description was recorded.";
}

function riskAssessment(
  findings: readonly { readonly disposition: string }[],
  reviewSummary: string,
): string {
  const blockers = findings.filter((f) => f.disposition === "blocker").length;
  const shouldFix = findings.filter((f) => f.disposition === "should-fix").length;
  const consider = findings.filter((f) => f.disposition === "consider").length;
  const nits = findings.filter((f) => f.disposition === "nit").length;
  const lines = [
    `- Unresolved findings: ${blockers} blocker, ${shouldFix} should-fix, ${consider} consider, ${nits} nit.`,
  ];
  const review = reviewSummary.trim();
  if (review.length > 0) lines.push("", review);
  return lines.join("\n");
}

function testingSummary(rounds: readonly RoundRecord[]): string {
  const checkSteps = new Set(["quality", "test"]);
  const summaries = summarizeStepRounds(rounds).filter((summary) => checkSteps.has(summary.step));
  if (summaries.length === 0) return "No local check rounds recorded.";
  return summaries
    .map(
      (summary) => `- ${summary.step}: ${summary.status === "clean" ? "clean" : "findings remain"}`,
    )
    .join("\n");
}
