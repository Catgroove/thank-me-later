// Small pure formatting helpers shared by the TUI components: status glyphs/labels and human
// duration/elapsed strings.

import {
  findingLifecycle,
  type Finding,
  type FindingDisposition,
  type FindingLifecycle,
  type FindingStatus,
} from "@tml/core";
import type { PhaseView, StepView, ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import { theme } from "./theme.ts";

export type StepStatus = StepView["status"];

/** Disposition accent color, shared by the findings inspector and the approval drawer. */
export const DISPOSITION_COLOR = theme.disposition;

/** Severity order, worst first, so the eye lands on blockers before nits. */
const DISPOSITION_RANK: Record<FindingDisposition, number> = {
  blocker: 0,
  "should-fix": 1,
  consider: 2,
  nit: 3,
};

/** Sort comparator: strongest disposition first, stable for equal dispositions. */
export function byDisposition(a: Finding, b: Finding): number {
  return DISPOSITION_RANK[a.disposition] - DISPOSITION_RANK[b.disposition];
}

/** The `[disposition]` marker prefixing a finding line in both finding surfaces. */
export function findingMarker(finding: Finding): string {
  return `[${finding.disposition}]`;
}

// Each lifecycle status gets a checkbox-style glyph, a short tag, and a color, so a Step's findings
// read as a to-do list that checks itself off: queued fixes show ⟳ pending, a verified fix shows a
// green ✓, an operator decision shows its outcome. Resolved items recede (dim) so attention lands on
// what still needs work. Shared by the rail tally and the Findings inspector.
export const STATUS_META: Record<
  FindingStatus,
  {
    readonly glyph: string;
    readonly tag: string;
    readonly color: string;
    readonly resolved: boolean;
  }
> = {
  open: { glyph: "○", tag: "", color: theme.textMuted, resolved: false },
  pending: { glyph: "⟳", tag: "pending", color: theme.accent, resolved: false },
  fixed: { glyph: "✓", tag: "fixed", color: theme.success, resolved: true },
  unresolved: { glyph: "✗", tag: "unresolved", color: theme.failed, resolved: false },
  accepted: { glyph: "✓", tag: "accepted as-is", color: theme.success, resolved: true },
  skipped: { glyph: "⤼", tag: "skipped", color: theme.textMuted, resolved: true },
};

/**
 * A Step's findings as a cumulative checklist with their lifecycle status, derived from the whole
 * round history (not just the latest round) so resolved findings stay visible with a ✓ instead of
 * silently vanishing. A finding the current passes have surfaced but not yet recorded in a round is
 * appended as a live `open` preview, so findings appear the moment a pass lands. Shared by the rail
 * (compact tally) and the inspector (full checklist).
 */
export function stepChecklist(step: StepView): FindingLifecycle[] {
  const lifecycle = findingLifecycle(step.rounds, { settled: step.status !== "active" });
  const known = new Set(lifecycle.map((entry) => entry.finding.id));
  const preview: FindingLifecycle[] = [];
  for (const phase of latestGroupPhases(step)) {
    for (const finding of phase.findings) {
      if (known.has(finding.id)) continue;
      known.add(finding.id);
      preview.push({ finding, status: "open" });
    }
  }
  return [...lifecycle, ...preview];
}

/** A single glyph+count chip in a findings tally, coloured and labelled by its lifecycle bucket. */
export interface TallySegment {
  readonly glyph: string;
  readonly count: number;
  readonly color: string;
  readonly label: string;
}

/**
 * The lifecycle buckets a findings tally reports, in priority order: what needs attention first
 * (pending fixes, your decisions, unresolved) before what is already settled (fixed, accepted,
 * skipped). The "needs you" bucket is the open findings routed to the human gate, so it carries the
 * waiting glyph rather than a status glyph. Shared so the rail chips and the inspector's one-line
 * tally never drift apart.
 */
export function findingTally(entries: readonly FindingLifecycle[]): TallySegment[] {
  const count = (predicate: (entry: FindingLifecycle) => boolean) =>
    entries.filter(predicate).length;
  const chip = (status: FindingStatus, label: string, n: number): TallySegment => ({
    glyph: STATUS_META[status].glyph,
    color: STATUS_META[status].color,
    label,
    count: n,
  });
  const buckets: TallySegment[] = [
    chip(
      "pending",
      "pending",
      count((e) => e.status === "pending"),
    ),
    {
      glyph: WAITING_GLYPH,
      color: WAITING_COLOR,
      label: "needs you",
      count: count((e) => e.status === "open" && e.finding.action === "ask-user"),
    },
    chip(
      "unresolved",
      "unresolved",
      count((e) => e.status === "unresolved"),
    ),
    chip(
      "fixed",
      "fixed",
      count((e) => e.status === "fixed"),
    ),
    chip(
      "accepted",
      "accepted",
      count((e) => e.status === "accepted"),
    ),
    chip(
      "skipped",
      "skipped",
      count((e) => e.status === "skipped"),
    ),
  ];
  return buckets.filter((segment) => segment.count > 0);
}

/** A one-line, human-readable rendering of {@link findingTally}, for the inspector header. */
export function progressLine(entries: readonly FindingLifecycle[]): string {
  return findingTally(entries)
    .map((segment) => `${segment.glyph} ${segment.count} ${segment.label}`)
    .join(" · ");
}

/**
 * The phases of a Step's latest group (the most recently started), deduped by label keeping the
 * latest - so a re-run pass replaces its earlier appearance rather than doubling. Returns [] for
 * Steps that declare no phases, so callers stay generic over the Pipeline.
 */
export function latestGroupPhases(step: StepView): PhaseView[] {
  const last = step.phases[step.phases.length - 1];
  if (last === undefined) return [];
  const byLabel = new Map<string, PhaseView>();
  for (const phase of step.phases) {
    if (phase.group === last.group) byLabel.set(phase.label, phase);
  }
  return [...byLabel.values()];
}

const GLYPHS: Record<StepStatus, string> = {
  pending: "·",
  active: "▸",
  done: "✓",
  skipped: "⤼",
  failed: "✗",
};

const COLORS: Record<StepStatus, string> = {
  pending: theme.textFaint,
  active: theme.accent,
  done: theme.success,
  skipped: theme.textMuted,
  failed: theme.failed,
};

export function statusGlyph(status: StepStatus): string {
  return GLYPHS[status];
}

export function statusColor(status: StepStatus): string {
  return COLORS[status];
}

/**
 * Glyph and color for an active Step blocked on a human decision (an `ask`/`approval` gate). Such a
 * Step is not working - it is waiting on *you* - so it must not wear the busy spinner. The `waiting`
 * accent matches the interaction drawer's "input needed"/"approval needed" framing.
 */
export const WAITING_GLYPH = "?";
export const WAITING_COLOR = theme.waiting;

/** A compact human duration: "0.4s", "12s", "3m 05s". Empty when unknown. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  // Round to whole seconds *before* splitting into minutes/seconds, so a value that rounds up to a
  // full minute carries into the minutes field instead of producing "1m 60s" or a bare "60s".
  const whole = Math.round(secs);
  if (whole < 60) return `${whole}s`;
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/**
 * Elapsed time for a Step: its recorded duration once finished, else a live `now - startedAt` with
 * time already spent waiting excluded. `now` is supplied by the caller (the renderer's local clock)
 * so this stays pure. `pendingAt` is the timestamp the Step blocked on a human decision, if it is
 * blocked right now: the clock freezes there, so deliberation does not inflate the elapsed.
 */
export function stepElapsed(step: StepView, now: number, pendingAt?: number): string {
  if (step.durationMs !== undefined) return formatDuration(step.durationMs);
  if (step.status === "active" && step.startedAt !== undefined) {
    const end = pendingAt ?? now;
    return formatDuration(Math.max(0, end - step.startedAt - (step.waitedMs ?? 0)));
  }
  return "";
}

/** Elapsed time for a Phase: fixed after finish, live while active. */
export function phaseElapsed(phase: PhaseView, now: number): string {
  const end = phase.finishedAt ?? (phase.status === "active" ? now : undefined);
  if (end === undefined) return "";
  return formatDuration(Math.max(0, end - phase.startedAt));
}

/**
 * Elapsed time for the whole Run: end-to-end once finished, else live from start. Time spent
 * blocked on a human decision is excluded - already-resolved waits via the Steps' `waitedMs`, and
 * the current one (if any) by freezing the clock at the interaction's timestamp.
 */
export function runElapsed(view: ViewState, now: number): string {
  if (view.startedAt === undefined) return "";
  const end = view.finishedAt ?? view.pendingInteraction?.at ?? now;
  const waited = view.steps.reduce((sum, step) => sum + (step.waitedMs ?? 0), 0);
  return formatDuration(Math.max(0, end - view.startedAt - waited));
}

// Column budget for the pipeline rail, beyond the longest Step name / Phase label:
const RAIL_MIN_WIDTH = 30; // never shrink below the historical fixed width
const RAIL_MAX_WIDTH = 56; // cap so the Step inspector keeps room on narrow terminals
const RAIL_TRAIL = 8; // leading space + widest elapsed ("10m 09s")
const RAIL_STEP_LEAD = 2; // status glyph + one-space margin before the name
const RAIL_PHASE_LEAD = 5; // " └ " tree branch + glyph + one-space margin before the label
const RAIL_FRAME = 4; // left+right border (2) + left+right row padding (2)

/**
 * Width (in columns) for the pipeline rail: it grows to fit the longest Step name (and, for an
 * active Step, its visible Phase labels) so a name and its elapsed time never collide, clamped to a
 * fixed band so the Step inspector keeps room. The trailing elapsed/count zone is a fixed reserve
 * rather than measured, so the width holds steady as the clock ticks instead of jiggling each second
 * when an elapsed string lengthens. Pure: derived from the labels alone, independent of `now`.
 */
export function railWidth(view: ViewState): number {
  let widest = 0;
  for (const step of view.steps) {
    widest = Math.max(widest, RAIL_STEP_LEAD + sanitize(step.name).length);
    if (step.status === "active") {
      for (const phase of latestGroupPhases(step)) {
        widest = Math.max(widest, RAIL_PHASE_LEAD + sanitize(phase.label).length);
      }
    }
  }
  const content = widest + RAIL_TRAIL + RAIL_FRAME;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, content));
}
