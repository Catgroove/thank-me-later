// The structured side of review: a throw-on-mismatch parser for the pass reply (the agent returns
// JSON against `findingsSchema`), and the pure synthesis of the review result into the single
// `reviewSummary` markdown. Risk and the found/fixed overview are computed here, in code - the agent
// never sets them. The overview is derived from the round history via `findingLifecycle`, the same
// source the TUI reads, so the live log, the PR body, and the inspector never disagree. No `ctx`, so
// all of this is unit-testable in isolation.

import {
  findingLifecycle,
  parseAgentFindingsOutput,
  renderFindingForPrText,
  type Finding,
  type FindingDisposition,
  type FindingLifecycle,
  type FindingStatus,
  type RoundRecord,
  type RoundRecordInput,
} from "@tml/core";

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

/** A one-line, plain-English tally of a single review pass's findings, for the live log. The
 *  structured JSON the agent returns is suppressed from the trail, so this is what the operator reads
 *  as the pass lands - before any fixes run. */
export function findingsLogLine(findings: readonly Finding[]): string {
  if (findings.length === 0) return "no findings";
  const autoFix = findings.filter((f) => f.action === "auto-fix").length;
  const decide = findings.filter((f) => f.action === "ask-user").length;
  const split = [
    autoFix > 0 ? `${autoFix} to auto-fix` : null,
    decide > 0 ? `${decide} for you` : null,
  ].filter((s): s is string => s !== null);
  const tail = split.length > 0 ? ` · ${split.join(", ")}` : "";
  const noun = findings.length === 1 ? "finding" : "findings";
  return `found ${findings.length} ${noun} (risk: ${riskOf(findings)})${tail}`;
}

const RESOLVED: ReadonlySet<FindingStatus> = new Set<FindingStatus>([
  "fixed",
  "accepted",
  "skipped",
]);

/** Worst-first severity order for the PR-body breakdown, so blockers read before nits. */
const DISPOSITION_RANK: Record<FindingDisposition, number> = {
  blocker: 0,
  "should-fix": 1,
  consider: 2,
  nit: 3,
};

/** The end-of-run accounting of a review: how many findings were raised and where they landed. */
export interface ReviewTally {
  readonly found: number;
  readonly fixed: number;
  /** auto-fix findings the fix pass did not (or could not) resolve. */
  readonly unresolvedAutoFix: number;
  /** ask-user findings still awaiting the operator's decision. */
  readonly needsYou: number;
  readonly accepted: number;
  /** purely informational (no-op) findings. */
  readonly noted: number;
}

/** Stamp the loop's bare round inputs with the ordering `findingLifecycle` needs (they arrive in
 *  recorded order, so the array index is the round index) and fold them into per-finding lifecycle. */
function lifecycleOf(rounds: readonly RoundRecordInput[]): FindingLifecycle[] {
  const stamped: RoundRecord[] = rounds.map((round, index) => ({
    ...round,
    step: "review",
    index,
  }));
  return findingLifecycle(stamped, { settled: true });
}

/** Tally a review's recorded rounds into the found/fixed/needs-you/noted accounting. */
export function reviewTally(rounds: readonly RoundRecordInput[]): ReviewTally {
  const lifecycle = lifecycleOf(rounds);
  const unresolved = (entry: FindingLifecycle) => !RESOLVED.has(entry.status);
  return {
    found: lifecycle.length,
    fixed: lifecycle.filter((e) => e.status === "fixed").length,
    accepted: lifecycle.filter((e) => e.status === "accepted").length,
    unresolvedAutoFix: lifecycle.filter((e) => e.finding.action === "auto-fix" && unresolved(e))
      .length,
    needsYou: lifecycle.filter((e) => e.finding.action === "ask-user" && unresolved(e)).length,
    noted: lifecycle.filter((e) => e.finding.action === "no-op").length,
  };
}

/** A one-line found-to-outcome overview: `N findings → M auto-fixed · K need your decision · J noted`.
 *  Drives both the completion log line and the PR-body head, so they always read the same. */
export function overviewLine(tally: ReviewTally): string {
  if (tally.found === 0) return "no findings";
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const parts = [
    tally.fixed > 0 ? `${tally.fixed} auto-fixed` : null,
    tally.unresolvedAutoFix > 0
      ? `${tally.unresolvedAutoFix} still ${plural(tally.unresolvedAutoFix, "needs", "need")} a fix`
      : null,
    tally.needsYou > 0
      ? `${tally.needsYou} ${plural(tally.needsYou, "needs", "need")} your decision`
      : null,
    tally.accepted > 0 ? `${tally.accepted} accepted` : null,
    tally.noted > 0 ? `${tally.noted} noted` : null,
  ].filter((s): s is string => s !== null);
  const head = `${tally.found} ${plural(tally.found, "finding", "findings")}`;
  return parts.length > 0 ? `${head} → ${parts.join(" · ")}` : head;
}

/** Status prefix for a finding line in the PR breakdown; open findings carry none. */
const STATUS_PREFIX: Record<FindingStatus, string> = {
  open: "",
  pending: "pending",
  fixed: "fixed",
  unresolved: "unresolved",
  accepted: "accepted",
  skipped: "skipped",
};

function renderLifecycleForPr(entry: FindingLifecycle): string {
  const prefix = STATUS_PREFIX[entry.status];
  return `- ${prefix ? `**${prefix}:** ` : ""}${renderFindingForPrText(entry.finding)}`;
}

/** Fold the recorded rounds into the `reviewSummary` markdown. Above the fold: the unresolved risk,
 *  the found-to-outcome overview, and the fixes applied. The full breakdown - every finding with its
 *  lifecycle status, worst severity first, so a reader sees what was fixed and what still stands - is
 *  tucked into a collapsible `<details>` to keep the PR body scannable. Deterministic. */
export function summarize(rounds: readonly RoundRecordInput[], fixSummary: string): string {
  const lifecycle = [...lifecycleOf(rounds)].sort(
    (a, b) => DISPOSITION_RANK[a.finding.disposition] - DISPOSITION_RANK[b.finding.disposition],
  );
  const unresolved = lifecycle.filter((e) => !RESOLVED.has(e.status)).map((e) => e.finding);
  const tally = reviewTally(rounds);
  const fixes = fixSummary.trim();

  const head: string[] = [`**Risk: ${riskOf(unresolved)}**`, ""];
  if (tally.found > 0) head.push(overviewLine(tally), "");
  if (fixes.length > 0) head.push(`**Fixes applied:** ${fixes}`, "");

  const lines = [...head];
  if (lifecycle.length > 0) {
    lines.push(
      "<details>",
      "<summary>Full review</summary>",
      "",
      ...lifecycle.map(renderLifecycleForPr),
      "",
      "</details>",
    );
  } else {
    lines.push("No findings.");
  }
  return lines.join("\n").trim();
}
