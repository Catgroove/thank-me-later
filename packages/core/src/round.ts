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
  readonly blocking?: boolean;
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

export interface StepRoundSummary {
  readonly step: string;
  readonly rounds: number;
  readonly autoFixes: number;
  readonly finalTrigger: RoundTrigger;
  readonly finalFindings: number;
  readonly status: "clean" | "unresolved";
}

export type FindingInput = Omit<Finding, "id">;
export type RoundRecordInput = Omit<RoundRecord, "step" | "index">;

/** Deterministic ID for a finding within a Step or pass namespace. Detail text is excluded so the same issue keeps a stable id across reworded verification rounds. */
export function findingId(namespace: string, finding: FindingInput): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        namespace,
        severity: finding.severity,
        action: finding.action,
        title: finding.title.trim(),
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

const SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>(["error", "warning", "info"]);
const ACTIONS: ReadonlySet<string> = new Set<FindingAction>(["auto-fix", "ask-user", "no-op"]);

export interface ParseAgentFindingsOptions {
  readonly namespace: string;
  readonly sourceName?: string;
  readonly enforceActionForSeverity?: boolean;
}

/** Validate an agent's structured `{ findings }` reply into core Findings. */
export function parseAgentFindingsOutput(
  output: unknown,
  options: ParseAgentFindingsOptions,
): Finding[] {
  const sourceName = options.sourceName ?? options.namespace;
  if (typeof output !== "object" || output === null) {
    throw new Error(`${sourceName}: the agent did not return a structured findings result`);
  }
  const obj = output as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    throw new Error(`${sourceName}: the result is missing a findings array`);
  }
  return obj.findings.map((raw, i) => parseAgentFinding(raw, i, options));
}

function parseAgentFinding(
  raw: unknown,
  index: number,
  options: ParseAgentFindingsOptions,
): Finding {
  const sourceName = options.sourceName ?? options.namespace;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${sourceName}: finding ${index} is not an object`);
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) {
    throw new Error(`${sourceName}: finding ${index} has an invalid severity`);
  }
  if (typeof f.action !== "string" || !ACTIONS.has(f.action)) {
    throw new Error(`${sourceName}: finding ${index} has an invalid action`);
  }
  if (options.enforceActionForSeverity && !isAllowedActionForSeverity(f.severity, f.action)) {
    throw new Error(
      `${sourceName}: finding ${index} has action ${f.action} for severity ${f.severity}; ` +
        "error and warning findings must be auto-fix or ask-user, and info findings must be no-op",
    );
  }
  if (typeof f.title !== "string" || f.title.trim().length === 0) {
    throw new Error(`${sourceName}: finding ${index} is missing a title`);
  }
  if (typeof f.detail !== "string") {
    throw new Error(`${sourceName}: finding ${index} is missing a detail`);
  }
  return makeFinding(options.namespace, {
    severity: f.severity as Finding["severity"],
    action: f.action as Finding["action"],
    title: f.title.trim(),
    detail: f.detail.trim(),
    ...(typeof f.location === "string" && f.location.trim().length > 0
      ? { location: f.location.trim() }
      : {}),
    ...(typeof f.blocking === "boolean" ? { blocking: f.blocking } : {}),
  });
}

function isAllowedActionForSeverity(severity: string, action: string): boolean {
  if (severity === "info") return action === "no-op";
  return action === "auto-fix" || action === "ask-user";
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
  const prefix =
    finding.blocking === true ? `Blocking ${label(finding.severity)}` : label(finding.severity);
  const action =
    finding.action === "auto-fix"
      ? " (auto-fix)"
      : finding.action === "ask-user"
        ? " (needs user decision)"
        : "";
  return `- ${prefix}:${location} ${finding.title} - ${finding.detail}${action}`;
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

/**
 * Compact rendering of one completed round for a fresh-agent prompt. Unlike the
 * PR renderer this is the flat, heading-free form fed back to agents (round
 * history) and to the approval gate (decision context), so both surfaces give
 * an identical account of every prior round - user notes included.
 */
export function renderRoundForPrompt(round: RoundRecordInput, index: number): string {
  const lines = [`Round ${index}: ${round.trigger}`];
  if (round.findings.length === 0) lines.push("No findings.");
  else lines.push(...round.findings.map(renderFindingForPr));
  if (round.selectedFindingIds && round.selectedFindingIds.length > 0) {
    lines.push(`Selected: ${round.selectedFindingIds.join(", ")}`);
  }
  if (round.userNotes && Object.keys(round.userNotes).length > 0) {
    lines.push("User notes:");
    for (const [id, note] of Object.entries(round.userNotes)) lines.push(`- ${id}: ${note}`);
  }
  if (round.fixSummary?.trim()) lines.push(`Fix summary: ${round.fixSummary.trim()}`);
  if (round.commitSha) lines.push(`Commit: ${round.commitSha}`);
  return lines.join("\n");
}

/** Compact rendering of completed rounds for a fresh-agent prompt. */
export function renderRoundsForPrompt(rounds: readonly RoundRecordInput[]): string {
  if (rounds.length === 0) return "No prior rounds.";
  return rounds.map(renderRoundForPrompt).join("\n\n");
}

/** Current findings are the findings from the latest recorded round per Step. */
export function currentFindings(rounds: readonly RoundRecord[]): Finding[] {
  return summarizeStepRounds(rounds).flatMap(
    (summary) => latestRound(rounds, summary.step).findings,
  );
}

/** Deterministic, compact per-Step summary for PR bodies and other audit surfaces. */
export function summarizeStepRounds(rounds: readonly RoundRecord[]): StepRoundSummary[] {
  const byStep = new Map<string, RoundRecord[]>();
  for (const round of rounds) {
    const group = byStep.get(round.step) ?? [];
    group.push(round);
    byStep.set(round.step, group);
  }

  return [...byStep.entries()].map(([step, records]) => {
    const latest = records.reduce((a, b) => (b.index > a.index ? b : a));
    const finalFindings = latest.findings.length;
    return {
      step,
      rounds: records.length,
      autoFixes: records.filter((r) => r.trigger === "auto_fix").length,
      finalTrigger: latest.trigger,
      finalFindings,
      status: finalFindings === 0 ? "clean" : "unresolved",
    };
  });
}

/** Pure Markdown rendering for a deterministic PR pipeline summary table. */
export function renderPipelineSummaryForPr(rounds: readonly RoundRecord[]): string {
  const summaries = summarizeStepRounds(rounds);
  if (summaries.length === 0) return "No local rounds recorded.";
  const lines = [
    "| Step | Status | Rounds | Auto-fixes | Final trigger | Final findings |",
    "| --- | --- | ---: | ---: | --- | ---: |",
  ];
  for (const s of summaries) {
    lines.push(
      `| ${escapeTableCell(s.step)} | ${s.status} | ${s.rounds} | ${s.autoFixes} | ${s.finalTrigger} | ${s.finalFindings} |`,
    );
  }
  return lines.join("\n");
}

/** Pure Markdown rendering for findings still present in the latest round of each Step. */
export function renderUnresolvedFindingsForPr(rounds: readonly RoundRecord[]): string {
  const findings = currentFindings(rounds);
  if (findings.length === 0) return "No unresolved findings.";
  return findings.map(renderFindingForPr).join("\n");
}

function latestRound(rounds: readonly RoundRecord[], step: string): RoundRecord {
  const matches = rounds.filter((round) => round.step === step);
  if (matches.length === 0) throw new Error(`no rounds recorded for Step ${step}`);
  return matches.reduce((a, b) => (b.index > a.index ? b : a));
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
