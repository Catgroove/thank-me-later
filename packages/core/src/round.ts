// Shared outcome records for review, checks, and CI. A Finding is the smallest
// actionable observation; a RoundRecord is one completed pass of a Step over a
// set of findings. The model is intentionally small so review, lint, typecheck,
// tests, and CI all speak the same language.

import { createHash } from "node:crypto";

export type FindingAction = "auto-fix" | "ask-user" | "no-op";
export type FindingSeverity = "error" | "warning" | "info";
export type RoundTrigger = "initial" | "auto_fix" | "user_fix" | "verify";

export interface Finding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly action: FindingAction;
  readonly title: string;
  readonly detail: string;
  readonly location?: string;
}

export interface RoundRecord {
  readonly step: string;
  readonly index: number;
  readonly trigger: RoundTrigger;
  readonly findings: Finding[];
  readonly selectedFindingIds?: string[];
  readonly userNotes?: Record<string, string>;
  readonly fixSummary?: string;
  readonly commitSha?: string;
}

export type FindingInput = Omit<Finding, "id">;
export type RoundRecordInput = Omit<RoundRecord, "step" | "index">;

/** Deterministic ID for a finding within a Step or pass namespace. */
export function findingId(namespace: string, finding: FindingInput): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        namespace,
        severity: finding.severity,
        action: finding.action,
        title: finding.title.trim(),
        detail: finding.detail.trim(),
        location: finding.location?.trim() ?? "",
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return `${slug(namespace)}:${hash}`;
}

export function makeFinding(namespace: string, finding: FindingInput): Finding {
  return { ...finding, id: findingId(namespace, finding) };
}

function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "finding";
}

function label(severity: FindingSeverity): string {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Info";
}

/** Pure Markdown rendering for a single PR-summary finding line. */
export function renderFindingForPr(finding: Finding): string {
  const location = finding.location ? ` \`${finding.location}\`` : "";
  const action =
    finding.action === "auto-fix"
      ? " (auto-fix)"
      : finding.action === "ask-user"
        ? " (needs user decision)"
        : "";
  return `- ${label(finding.severity)}:${location} ${finding.title} - ${finding.detail}${action}`;
}

/** Pure Markdown rendering for one completed round in a PR summary. */
export function renderRoundForPr(round: RoundRecord): string {
  const lines = [`### ${round.step} round ${round.index}`, `Trigger: ${round.trigger}`, ""];
  if (round.commitSha) lines.push(`Commit: \`${round.commitSha}\``, "");
  if (round.fixSummary?.trim()) lines.push(`Fixes applied: ${round.fixSummary.trim()}`, "");
  if (round.findings.length === 0) {
    lines.push("No findings.");
  } else {
    lines.push(...round.findings.map(renderFindingForPr));
  }
  if (round.selectedFindingIds && round.selectedFindingIds.length > 0) {
    lines.push(
      "",
      `Selected findings: ${round.selectedFindingIds.map((id) => `\`${id}\``).join(", ")}`,
    );
  }
  if (round.userNotes && Object.keys(round.userNotes).length > 0) {
    lines.push("", "User notes:");
    for (const [id, note] of Object.entries(round.userNotes)) {
      lines.push(`- \`${id}\`: ${note}`);
    }
  }
  return lines.join("\n").trim();
}

/** Pure Markdown rendering for multiple PR-summary rounds. */
export function renderRoundsForPr(rounds: readonly RoundRecord[]): string {
  if (rounds.length === 0) return "No rounds recorded.";
  return rounds.map(renderRoundForPr).join("\n\n");
}
