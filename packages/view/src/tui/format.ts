// Small pure formatting helpers shared by the TUI components: status glyphs/labels and human
// duration/elapsed strings. Kept generic - no Step-name knowledge, no default-Pipeline assumptions.

import type { Finding, FindingDisposition } from "@tml/core";
import type { PhaseView, StepView, ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";

export type StepStatus = StepView["status"];

/** Disposition accent color, shared by the findings inspector and the approval drawer. */
export const DISPOSITION_COLOR: Record<FindingDisposition, string> = {
  blocker: "#ef4444",
  "should-fix": "#f59e0b",
  consider: "#38bdf8",
  nit: "#94a3b8",
};

/** The `[disposition]` marker prefixing a finding line in both finding surfaces. */
export function findingMarker(finding: Finding): string {
  return `[${finding.disposition}]`;
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
  pending: "#6b7280",
  active: "#38bdf8",
  done: "#22c55e",
  skipped: "#9ca3af",
  failed: "#ef4444",
};

export function statusGlyph(status: StepStatus): string {
  return GLYPHS[status];
}

export function statusColor(status: StepStatus): string {
  return COLORS[status];
}

/**
 * Glyph and color for an active Step blocked on a human decision (an `ask`/`approval` gate). Such a
 * Step is not working - it is waiting on *you* - so it must not wear the busy spinner. The amber
 * matches the interaction drawer's "input needed"/"approval needed" framing.
 */
export const WAITING_GLYPH = "?";
export const WAITING_COLOR = "#f59e0b";

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
const RAIL_TRAIL = 11; // leading space + widest elapsed ("10m 09s") + a findings count (" 99")
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
