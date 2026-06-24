// Deterministic PR-body policy for the default pipeline. The generated block owns tml's audit
// surface, including the agent-authored description. On re-runs, tml refreshes only the marked
// block so human edits around it survive. The block is not a PR comment or review thread.

import {
  renderPipelineSummaryForPr,
  renderRoundNarrativeForPr,
  renderUnresolvedFindingsForPr,
  summarizeStepRounds,
  unresolvedFindings,
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
  const unresolved = unresolvedFindings(input.rounds);
  return [
    START,
    "## What changed",
    cleanDescription(input.description),
    "",
    "## Risk assessment",
    riskAssessment(unresolved, input.reviewSummary),
    "",
    "## Testing",
    testingSummary(input.rounds),
    "",
    "## Pipeline",
    "### Summary",
    renderPipelineSummaryForPr(input.rounds),
    "",
    "### Rounds",
    renderRoundNarrativeForPr(input.rounds),
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
  const checkSteps = new Set(["quality", "test", "ci-wait"]);
  const summaries = summarizeStepRounds(rounds).filter((summary) => checkSteps.has(summary.step));
  const evidence = latestTestingEvidence(rounds, checkSteps);
  if (summaries.length === 0 && evidence.length === 0) return "No local check rounds recorded.";

  const lines: string[] = [];
  if (summaries.length > 0) {
    lines.push(
      ...summaries.map((summary) => `- ${summary.step}: ${testingStatus(summary.status)}`),
    );
  }
  if (evidence.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Evidence:");
    for (const round of evidence) {
      const status = round.tested === undefined ? "unknown" : round.tested ? "tested" : "not run";
      const summary = round.testingSummary?.trim() ?? "No testing summary recorded.";
      lines.push(`- ${round.step} round ${round.index}: ${status} - ${summary}`);
      for (const artifact of round.artifacts ?? []) lines.push(`  - ${artifact}`);
    }
  }
  return lines.join("\n");
}

function latestTestingEvidence(
  rounds: readonly RoundRecord[],
  checkSteps: ReadonlySet<string>,
): RoundRecord[] {
  const latest = new Map<string, RoundRecord>();
  for (const round of rounds) {
    if (!checkSteps.has(round.step)) continue;
    if (!round.testingSummary && round.tested === undefined && !round.artifacts?.length) continue;
    const prior = latest.get(round.step);
    if (prior === undefined || round.index > prior.index) latest.set(round.step, round);
  }
  return [...latest.values()];
}

function testingStatus(status: ReturnType<typeof summarizeStepRounds>[number]["status"]): string {
  if (status === "clean") return "clean";
  if (status === "accepted") return "accepted by operator";
  if (status === "skipped") return "skipped by operator";
  return "findings remain";
}
