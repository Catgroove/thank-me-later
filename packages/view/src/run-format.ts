// Presentation helpers for a Run history row, shared by the CLI plain table and the TUI picker so
// the two never drift. State reflects liveness (an orphaned `running` Run reads as orphaned, not a
// phantom in progress); the label is the feature branch when known; the id is its short suffix.

import { classifyLiveness, type RunMetadata } from "@tml/core";

/** The status to show. A `running` Run is reported by liveness so an orphan is not a phantom. */
export function displayState(meta: RunMetadata, now: number): string {
  if (meta.status !== "running") return meta.status;
  switch (classifyLiveness(meta, { now })) {
    case "live":
      return "running";
    case "orphaned":
      return "orphaned";
    case "unknown":
      return "running?";
  }
}

/** The human label for a Run: the feature branch when known, else the start branch. */
export function runLabel(meta: RunMetadata): string {
  return meta.workspaceBranch ?? meta.resumeKey ?? "-";
}

/** The short, copyable form of a Run id: the random suffix after the timestamp. */
export function shortRunId(runId: string): string {
  const dash = runId.lastIndexOf("-");
  return dash >= 0 ? runId.slice(dash + 1) : runId;
}

/** Coarse age like `5s`, `3m`, `2h`, `4d`. */
export function humanizeAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Row accent color by displayed state, for the TUI picker. */
export function stateColor(state: string): string {
  switch (state) {
    case "running":
      return "#38bdf8";
    case "orphaned":
    case "running?":
      return "#f59e0b";
    case "finished":
      return "#22c55e";
    case "failed":
      return "#ef4444";
    case "cancelled":
      return "#9ca3af";
    default:
      return "#cbd5e1";
  }
}
