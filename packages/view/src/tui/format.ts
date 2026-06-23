// Small pure formatting helpers shared by the TUI components: status glyphs/labels and human
// duration/elapsed strings. Kept generic - no Step-name knowledge, no default-Pipeline assumptions.

import type { PhaseView, StepView, ViewState } from "../present.ts";

export type StepStatus = StepView["status"];

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

export function statusLabel(status: StepStatus): string {
  return status;
}

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
