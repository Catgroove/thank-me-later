// Shared outcome records for review, checks, and CI. A Finding is the smallest
// actionable observation; a RoundRecord is one completed pass of a Step over a
// set of findings. The model is intentionally small so review, lint, typecheck,
// tests, and CI all speak the same language.

import { createHash } from "node:crypto";

export type FindingAction = "auto-fix" | "ask-user" | "no-op";
// How strongly tml recommends acting on a finding. `blocker` gates the ship; `should-fix` is a
// clear improvement the author should make; `consider` is an optional suggestion; `nit` is a
// trivial take-it-or-leave-it remark.
export type FindingDisposition = "blocker" | "should-fix" | "consider" | "nit";
export type RoundTrigger = "initial" | "auto_fix" | "user_fix" | "verify";

/**
 * How a round resolved an operator decision, set only on the terminal round of an approval gate.
 * `approved` means the operator accepted the round's findings as-is; `skipped` means they skipped the
 * Step leaving them. Distinguishes a real fix round (no resolution) from an accept/skip so the
 * finding checklist can show "accepted as-is"/"skipped" instead of "still open".
 */
export type RoundResolution = "approved" | "skipped";

/**
 * The lifecycle of a single finding across a Step's rounds.
 *
 * - `open`: reported and not yet acted on.
 * - `pending`: selected for a fix that is applied or in flight, not yet verified.
 * - `fixed`: was fixed and a later verification pass no longer reports it.
 * - `unresolved`: a fix was attempted but the finding persists.
 * - `accepted`: the operator approved it as-is at the gate.
 * - `skipped`: the operator skipped the Step, leaving it.
 */
export type FindingStatus = "open" | "pending" | "fixed" | "unresolved" | "accepted" | "skipped";

/** One finding paired with its derived lifecycle status (see {@link findingLifecycle}). */
export interface FindingLifecycle {
  readonly finding: Finding;
  readonly status: FindingStatus;
}

export interface Finding {
  readonly id: string;
  readonly disposition: FindingDisposition;
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
  /** Set on the terminal round of an approval gate that the operator approved or skipped. */
  readonly resolution?: RoundResolution;
}

export interface StepRoundSummary {
  readonly step: string;
  readonly rounds: number;
  readonly autoFixes: number;
  readonly finalTrigger: RoundTrigger;
  readonly finalFindings: number;
  readonly status: "clean" | "unresolved";
}

export function isFixAttemptRound(round: Pick<RoundRecord, "trigger" | "resolution">): boolean {
  return (
    (round.trigger === "auto_fix" || round.trigger === "user_fix") && round.resolution === undefined
  );
}

export type FindingInput = Omit<Finding, "id">;
export type RoundRecordInput = Omit<RoundRecord, "step" | "index">;

/** Deterministic ID for a finding within a Step or pass namespace. Detail text is excluded so the same issue keeps a stable id across reworded verification rounds. */
export function findingId(namespace: string, finding: FindingInput): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        namespace,
        disposition: finding.disposition,
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

const DISPOSITIONS: ReadonlySet<string> = new Set<FindingDisposition>([
  "blocker",
  "should-fix",
  "consider",
  "nit",
]);
const ACTIONS: ReadonlySet<string> = new Set<FindingAction>(["auto-fix", "ask-user", "no-op"]);

export interface ParseAgentFindingsOptions {
  readonly namespace: string;
  readonly sourceName?: string;
  readonly enforceActionForDisposition?: boolean;
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
  if (typeof f.disposition !== "string" || !DISPOSITIONS.has(f.disposition)) {
    throw new Error(`${sourceName}: finding ${index} has an invalid disposition`);
  }
  if (typeof f.action !== "string" || !ACTIONS.has(f.action)) {
    throw new Error(`${sourceName}: finding ${index} has an invalid action`);
  }
  if (
    options.enforceActionForDisposition &&
    !isAllowedActionForDisposition(f.disposition, f.action)
  ) {
    throw new Error(
      `${sourceName}: finding ${index} has action ${f.action} for disposition ${f.disposition}; ` +
        "blocker and should-fix findings must be auto-fix or ask-user",
    );
  }
  if (typeof f.title !== "string" || f.title.trim().length === 0) {
    throw new Error(`${sourceName}: finding ${index} is missing a title`);
  }
  if (typeof f.detail !== "string") {
    throw new Error(`${sourceName}: finding ${index} is missing a detail`);
  }
  return makeFinding(options.namespace, {
    disposition: f.disposition as Finding["disposition"],
    action: f.action as Finding["action"],
    title: f.title.trim(),
    detail: f.detail.trim(),
    ...(typeof f.location === "string" && f.location.trim().length > 0
      ? { location: f.location.trim() }
      : {}),
  });
}

// A finding that recommends action cannot also do nothing: blocker and should-fix must carry a
// real action. consider and nit may use any action, including no-op for one tml is merely noting.
function isAllowedActionForDisposition(disposition: string, action: string): boolean {
  if (disposition === "blocker" || disposition === "should-fix") {
    return action === "auto-fix" || action === "ask-user";
  }
  return true;
}

function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "finding";
}

function label(disposition: FindingDisposition): string {
  if (disposition === "blocker") return "Blocker";
  if (disposition === "should-fix") return "Should fix";
  if (disposition === "consider") return "Consider";
  return "Nit";
}

/** Pure Markdown rendering for a single PR-summary finding line. */
export function renderFindingForPr(finding: Finding): string {
  const location = finding.location ? ` \`${finding.location}\`` : "";
  const prefix = label(finding.disposition);
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
function renderRoundForPrompt(round: RoundRecordInput, index: number): string {
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

/** The sentinel `renderRoundsForPrompt` emits when there is no prior round history. */
export const NO_PRIOR_ROUNDS = "No prior rounds.";

/** Compact rendering of completed rounds for a fresh-agent prompt. */
export function renderRoundsForPrompt(rounds: readonly RoundRecordInput[]): string {
  if (rounds.length === 0) return NO_PRIOR_ROUNDS;
  return rounds.map(renderRoundForPrompt).join("\n\n");
}

/** Whether round-history text holds real prior rounds, not the empty-history sentinel. */
export function hasPriorRounds(historyText: string): boolean {
  const trimmed = historyText.trim();
  return trimmed.length > 0 && trimmed !== NO_PRIOR_ROUNDS;
}

/**
 * Fold one Step's rounds into a per-finding lifecycle, in first-seen order. A finding's status is
 * derived entirely from the round history: which check round last reported it, whether a fix round
 * ever attempted it, what the last round queued, and any terminal approval resolution. Findings that
 * vanished without ever being acted on are dropped - the list is the work that mattered, not noise.
 *
 * `settled` (the Step is no longer active) collapses any lingering `pending` to `unresolved`: a fix
 * that is queued but will never run is not in flight. Pass the Step's rounds only, ordered or not.
 */
export function findingLifecycle(
  rounds: readonly RoundRecord[],
  opts: { readonly settled?: boolean } = {},
): FindingLifecycle[] {
  const ordered = [...rounds].sort((a, b) => a.index - b.index);

  const isCheck = (r: RoundRecord) => r.trigger === "initial" || r.trigger === "verify";

  // The freshest re-scan decides what is still reported; fix and approval rounds are not re-scans.
  const lastCheck = ordered.filter(isCheck).at(-1);
  const present = new Set(lastCheck?.findings.map((f) => f.id) ?? []);

  // A fix round records the findings it attempted; that is what can later be confirmed fixed.
  const attempted = new Set<string>();
  for (const r of ordered)
    if (isFixAttemptRound(r)) for (const f of r.findings) attempted.add(f.id);

  // The last round's queued/attempted set is in flight: a check that just selected fixes, or a fix
  // round awaiting its verify. Either way the fix has not yet been confirmed.
  const last = ordered.at(-1);
  const inFlight = new Set<string>();
  if (last !== undefined) {
    if (isFixAttemptRound(last)) for (const f of last.findings) inFlight.add(f.id);
    else if (isCheck(last)) for (const id of last.selectedFindingIds ?? []) inFlight.add(id);
  }

  // The terminal approval round stamps its findings accepted or skipped.
  const approval = ordered.filter((r) => r.resolution !== undefined).at(-1);
  const accepted = approval?.resolution === "approved" ? idSet(approval) : new Set<string>();
  const skipped = approval?.resolution === "skipped" ? idSet(approval) : new Set<string>();

  const latest = new Map<string, Finding>();
  const order: string[] = [];
  for (const r of ordered) {
    for (const f of r.findings) {
      if (!latest.has(f.id)) order.push(f.id);
      latest.set(f.id, f);
    }
  }

  const settled = opts.settled ?? false;
  const out: FindingLifecycle[] = [];
  for (const id of order) {
    const finding = latest.get(id);
    if (finding === undefined) continue;
    const status = lifecycleStatus({
      present: present.has(id),
      attempted: attempted.has(id),
      inFlight: inFlight.has(id),
      accepted: accepted.has(id),
      skipped: skipped.has(id),
      settled,
    });
    if (status === undefined) continue; // vanished without being acted on - not part of the work
    out.push({ finding, status });
  }
  return out;
}

function idSet(round: RoundRecord): Set<string> {
  return new Set(round.findings.map((f) => f.id));
}

interface LifecycleFacts {
  readonly present: boolean;
  readonly attempted: boolean;
  readonly inFlight: boolean;
  readonly accepted: boolean;
  readonly skipped: boolean;
  readonly settled: boolean;
}

function lifecycleStatus(f: LifecycleFacts): FindingStatus | undefined {
  if (!f.present) return f.attempted ? "fixed" : undefined;
  if (f.accepted) return "accepted";
  if (f.skipped) return "skipped";
  if (f.inFlight) return f.settled ? "unresolved" : "pending";
  if (f.attempted) return "unresolved";
  return "open";
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
