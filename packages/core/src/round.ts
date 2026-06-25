// Shared outcome records for Steps that report findings. A Finding is the smallest actionable
// observation; a RoundRecord is one completed pass of a Step over a set of findings. The model is
// intentionally small so independently-authored Steps can speak the same language.

import { createHash } from "node:crypto";

export type FindingAction = "auto-fix" | "ask-user" | "no-op";
// How strongly tml recommends acting on a finding. `blocker` gates the ship; `should-fix` is a
// clear improvement the author should make; `consider` is an optional suggestion; `nit` is a
// trivial take-it-or-leave-it remark.
export type FindingDisposition = "blocker" | "should-fix" | "consider" | "nit";
export type RoundTrigger = "initial" | "auto_fix" | "user_fix" | "verify" | "approval";

/**
 * How a round resolved an operator decision, set only on the terminal approval round.
 * `approved` means the operator accepted the round's findings as-is; `skipped` means they skipped the
 * Step leaving them. Distinguishes a real fix round from an accept/skip so the finding checklist can
 * show "accepted as-is"/"skipped" instead of "still open".
 */
export type RoundResolution = "approved" | "skipped";
export type ApprovalDecisionSource = "operator" | "auto";

export interface RoundTestingEvidence {
  readonly summary?: string;
  readonly tested?: boolean;
  readonly artifacts?: readonly string[];
}

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
  readonly testing?: RoundTestingEvidence;
  /** Set on the terminal round of an approval gate that the operator approved or skipped. */
  readonly resolution?: RoundResolution;
  /** Source of an approval gate decision. Omitted means a human operator. */
  readonly approvalSource?: ApprovalDecisionSource;
}

export interface StepRoundSummary {
  readonly step: string;
  readonly rounds: number;
  readonly autoFixes: number;
  readonly finalTrigger: RoundTrigger;
  readonly finalFindings: number;
  readonly status: "clean" | "unresolved" | "accepted" | "skipped";
}

export function isFixAttemptRound(round: Pick<RoundRecord, "trigger" | "resolution">): boolean {
  return (
    (round.trigger === "auto_fix" || round.trigger === "user_fix") && round.resolution === undefined
  );
}

export type FindingInput = Omit<Finding, "id">;
export type RoundTestingEvidenceInput = RoundTestingEvidence;
export type RoundRecordInput = Omit<RoundRecord, "step" | "index">;

function testingEvidenceFrom(
  input: { readonly testing?: RoundTestingEvidenceInput } | RoundTestingEvidenceInput | undefined,
): RoundTestingEvidenceInput | undefined {
  if (input === undefined) return undefined;
  if (isRoundWithTesting(input)) return input.testing;
  return input;
}

function isRoundWithTesting(
  input: { readonly testing?: RoundTestingEvidenceInput } | RoundTestingEvidenceInput,
): input is { readonly testing?: RoundTestingEvidenceInput } {
  return "testing" in input;
}

export function normalizeTestingEvidence(
  input: RoundTestingEvidenceInput | undefined,
): RoundTestingEvidence | undefined {
  if (input === undefined) return undefined;
  const summary = input.summary?.trim();
  const artifacts = input.artifacts
    ?.map((artifact) => artifact.trim())
    .filter((artifact) => artifact.length > 0);
  const normalized: RoundTestingEvidence = {
    ...(summary && summary.length > 0 ? { summary } : {}),
    ...(input.tested !== undefined ? { tested: input.tested } : {}),
    ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function hasTestingEvidence(
  input: { readonly testing?: RoundTestingEvidenceInput } | RoundTestingEvidenceInput | undefined,
): boolean {
  return normalizeTestingEvidence(testingEvidenceFrom(input)) !== undefined;
}

/**
 * Deterministic ID for addressing a finding within one round. It is best-effort across rounds only:
 * model-authored titles and locations can change during verification, so control flow must not
 * depend on this id as a stable issue identity.
 */
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

export function renderFindingForPrText(finding: Finding): string {
  const location = finding.location ? ` \`${finding.location}\`` : "";
  const prefix = label(finding.disposition);
  const action =
    finding.action === "auto-fix"
      ? " (auto-fix)"
      : finding.action === "ask-user"
        ? " (needs user decision)"
        : "";
  return `${prefix}:${location} ${finding.title} - ${finding.detail}${action}`;
}

/** Pure Markdown rendering for a single PR-summary finding line. */
export function renderFindingForPr(finding: Finding): string {
  return `- ${renderFindingForPrText(finding)}`;
}

/** Pure Markdown rendering for one completed round in a PR summary. */
export function renderRoundForPr(round: RoundRecord): string {
  const lines = [`### ${round.step} round ${round.index}`, `Trigger: ${round.trigger}`, ""];
  if (round.commitSha) lines.push(`Commit: \`${round.commitSha}\``, "");
  if (round.fixSummary?.trim()) lines.push(`Fixes applied: ${round.fixSummary.trim()}`, "");
  if (round.testing?.summary?.trim()) lines.push(`Testing: ${round.testing.summary.trim()}`, "");
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

export interface RoundNarrativeOptions {
  readonly commitBaseUrl?: string;
}

/** Deterministic issue -> fix -> verification narrative for PR audit sections. */
export function renderRoundNarrativeForPr(
  rounds: readonly RoundRecord[],
  options: RoundNarrativeOptions = {},
): string {
  const steps = roundsByStep(rounds);
  if (steps.length === 0) return "No local rounds recorded.";
  return steps.map(([step, records]) => renderStepNarrative(step, records, options)).join("\n\n");
}

function renderStepNarrative(
  step: string,
  rounds: readonly RoundRecord[],
  options: RoundNarrativeOptions,
): string {
  const ordered = [...rounds].sort((a, b) => a.index - b.index);
  const summary = summarizeStepRounds(ordered)[0];
  const lifecycle = findingLifecycle(ordered, { settled: true });
  const statusByFinding = new Map(lifecycle.map((item) => [item.finding.id, item.status]));
  const title = summary
    ? `${step} - ${summary.status} (${summary.rounds} rounds, ${summary.autoFixes} auto-fixes)`
    : step;
  const lines = [`<details>`, `<summary>${escapeHtml(title)}</summary>`, ""];
  for (const round of ordered)
    lines.push(renderNarrativeRound(round, statusByFinding, options), "");
  lines.push(`</details>`);
  return lines.join("\n").trim();
}

function renderNarrativeRound(
  round: RoundRecord,
  statusByFinding: ReadonlyMap<string, FindingStatus>,
  options: RoundNarrativeOptions,
): string {
  const lines = [`#### Round ${round.index}: ${roundLabel(round)}`];
  if (round.fixSummary?.trim()) lines.push(`- Fix summary: ${round.fixSummary.trim()}`);
  if (round.commitSha) lines.push(`- Fix commit: ${commitReference(round.commitSha, options)}`);
  if (round.testing?.summary?.trim()) {
    lines.push(`- Testing summary: ${round.testing.summary.trim()}`);
  }
  if (round.testing?.tested !== undefined) {
    lines.push(`- Tested: ${round.testing.tested ? "yes" : "no"}`);
  }
  if (round.testing?.artifacts && round.testing.artifacts.length > 0) {
    lines.push("- Testing artifacts:");
    for (const artifact of round.testing.artifacts) lines.push(`  - ${artifact}`);
  }
  if (round.resolution === "approved")
    lines.push("- Operator resolution: accepted remaining findings.");
  if (round.resolution === "skipped") lines.push("- Operator resolution: skipped this step.");

  if (round.findings.length === 0) {
    lines.push("- Findings: none.");
  } else {
    lines.push("- Findings:");
    for (const finding of round.findings) {
      const status = statusByFinding.get(finding.id);
      lines.push(`  - ${status ? `**${status}:** ` : ""}${renderFindingForPrText(finding)}`);
    }
  }

  if (round.selectedFindingIds && round.selectedFindingIds.length > 0) {
    const selected = renderSelectedFindings(round);
    lines.push(`- Selected for fix: ${selected}`);
  }
  if (round.userNotes && Object.keys(round.userNotes).length > 0) {
    lines.push("- Operator notes:");
    for (const [id, note] of Object.entries(round.userNotes)) lines.push(`  - \`${id}\`: ${note}`);
  }
  return lines.join("\n");
}

function roundLabel(round: RoundRecord): string {
  if (round.trigger === "initial") return "initial check";
  if (round.trigger === "verify") return "verification";
  if (round.trigger === "auto_fix") return "auto-fix";
  if (round.trigger === "user_fix") return "operator-requested fix";
  return "operator approval";
}

function renderSelectedFindings(round: RoundRecord): string {
  const byId = new Map(round.findings.map((finding) => [finding.id, finding]));
  return round
    .selectedFindingIds!.map((id) => {
      const finding = byId.get(id);
      return finding ? `${finding.title} (\`${id}\`)` : `\`${id}\``;
    })
    .join(", ");
}

function commitReference(sha: string, options: RoundNarrativeOptions): string {
  const short = sha.slice(0, 12);
  if (options.commitBaseUrl === undefined) return `\`${short}\``;
  return `[\`${short}\`](${options.commitBaseUrl.replace(/\/$/, "")}/${sha})`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The sentinel the agent-prompt round-history renderer emits when there is no prior round history. */
export const NO_PRIOR_ROUNDS = "No prior rounds.";

/** One ledger line for a finding in the agent-facing history: id, disposition/action, title, location. */
function renderFindingLedgerLine(finding: Finding): string {
  const location = finding.location ? ` (${finding.location})` : "";
  return `- ${finding.id} · ${finding.disposition}/${finding.action} · ${finding.title}${location}`;
}

/**
 * Lean rendering of one completed round for a fresh-agent prompt: the trigger, a one-line-per-finding
 * ledger partitioned into selected-to-fix vs. noted, and the fix summary and commit when present.
 * It carries no per-finding detail or operator notes - the agent re-derives detail from the live
 * worktree, so the history only needs the ledger of what was raised, selected, and done. The verbose
 * per-round account stays in the PR renderers ({@link renderRoundForPr}), which are human-facing.
 */
function renderRoundForAgentPrompt(round: RoundRecordInput, index: number): string {
  const lines = [`Round ${index}: ${round.trigger}`];
  if (round.findings.length === 0) {
    lines.push("No findings.");
  } else {
    const selected = new Set(round.selectedFindingIds ?? []);
    const selectedFindings = round.findings.filter((f) => selected.has(f.id));
    const noted = round.findings.filter((f) => !selected.has(f.id));
    if (selectedFindings.length > 0) {
      lines.push("Selected to fix:", ...selectedFindings.map(renderFindingLedgerLine));
    }
    if (noted.length > 0) {
      lines.push("Noted / not fixed:", ...noted.map(renderFindingLedgerLine));
    }
  }
  if (round.fixSummary?.trim()) lines.push(`Fix summary: ${round.fixSummary.trim()}`);
  if (round.commitSha) lines.push(`Commit: ${round.commitSha}`);
  return lines.join("\n");
}

/**
 * Compact, detail-free rendering of completed rounds for a fresh-agent prompt. This is the lean form
 * fed back to agents on verify and fix passes and to the approval gate; the verbose PR renderers
 * stay for human-facing surfaces. Emits {@link NO_PRIOR_ROUNDS} when there are no rounds so
 * `hasPriorRounds` keeps working unchanged.
 */
export function renderRoundsForAgentPrompt(rounds: readonly RoundRecordInput[]): string {
  if (rounds.length === 0) return NO_PRIOR_ROUNDS;
  return rounds.map(renderRoundForAgentPrompt).join("\n\n");
}

/** Whether round-history text holds real prior rounds, not the empty-history sentinel. */
export function hasPriorRounds(historyText: string): boolean {
  const trimmed = historyText.trim();
  return trimmed.length > 0 && trimmed !== NO_PRIOR_ROUNDS;
}

/**
 * Fold one Step's rounds into a per-finding lifecycle, in first-seen order. This is best-effort
 * display state based on finding ids, not authoritative reconciliation: a verify pass that rewords
 * or relocates the same issue can show the old id as fixed and the new id as open. A finding's
 * status is derived entirely from the round history: which check round last reported it, whether a
 * fix round ever attempted it, what the last round queued, and any terminal approval resolution.
 * Findings that vanished without ever being acted on are dropped - the list is the work that
 * mattered, not noise.
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

  // The last round's queued/attempted set is in flight: a check that just selected fixes, an
  // approval selection that just handed findings to the fixer, or a fix round awaiting its verify.
  // Either way the fix has not yet been confirmed.
  const last = ordered.at(-1);
  const inFlight = new Set<string>();
  if (last !== undefined) {
    if (isFixAttemptRound(last)) for (const f of last.findings) inFlight.add(f.id);
    else if (isCheck(last) || last.trigger === "approval") {
      for (const id of last.selectedFindingIds ?? []) inFlight.add(id);
    }
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
  return roundsByStep(rounds).map(([step, records]) => {
    const latest = records.reduce((a, b) => (b.index > a.index ? b : a));
    const finalFindings = latest.findings.length;
    return {
      step,
      rounds: records.length,
      autoFixes: records.filter((r) => r.trigger === "auto_fix").length,
      finalTrigger: latest.trigger,
      finalFindings,
      status: stepStatus(latest, finalFindings),
    };
  });
}

function roundsByStep(rounds: readonly RoundRecord[]): [string, RoundRecord[]][] {
  const byStep = new Map<string, RoundRecord[]>();
  for (const round of rounds) {
    const group = byStep.get(round.step) ?? [];
    group.push(round);
    byStep.set(round.step, group);
  }
  return [...byStep.entries()];
}

function stepStatus(latest: RoundRecord, finalFindings: number): StepRoundSummary["status"] {
  if (latest.resolution === "approved") return "accepted";
  if (latest.resolution === "skipped") return "skipped";
  return finalFindings === 0 ? "clean" : "unresolved";
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

/** Findings that are still open after excluding fixed and operator-accepted outcomes. */
export function unresolvedFindings(rounds: readonly RoundRecord[]): Finding[] {
  return roundsByStep(rounds).flatMap(([, records]) =>
    findingLifecycle(records, { settled: true })
      .filter(
        (item) =>
          item.status === "open" || item.status === "pending" || item.status === "unresolved",
      )
      .map((item) => item.finding),
  );
}

export function renderUnresolvedFindingsForPr(rounds: readonly RoundRecord[]): string {
  const findings = unresolvedFindings(rounds);
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
