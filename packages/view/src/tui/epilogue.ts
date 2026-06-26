// The post-TUI scrollback epilogue: a compact summary printed after the alternate screen is torn
// down, so the terminal keeps a useful trace of the Run without the full transcript. Pure (returns
// lines); the renderer writes them. Generic over the assembled Pipeline - it tallies by status and
// names the failed/cancelled Step from facts, never from concrete Step names.

import { sanitize } from "./sanitize.ts";
import type { ViewState } from "../present.ts";
import { runElapsed } from "./format.ts";

/** The compact epilogue lines for a finished/failed/cancelled Run. */
export function epilogueLines(view: ViewState, now: number): string[] {
  const lines: string[] = [];
  const elapsed = runElapsed(view, now);
  const elapsedSuffix = elapsed ? `  (${elapsed})` : "";

  switch (view.status) {
    case "finished":
      lines.push(`■ ship finished${elapsedSuffix}`);
      break;
    case "failed": {
      const failed = view.steps.find((s) => s.status === "failed");
      const where = failed ? ` at ${failed.name}` : "";
      lines.push(`✗ ship failed${where}${elapsedSuffix}`);
      if (view.error) lines.push(`  ${sanitize(view.error)}`);
      break;
    }
    case "cancelled": {
      const active = view.steps.find((s) => s.status === "active");
      const where = active ? ` at ${active.name}` : "";
      lines.push(`◼ ship cancelled${where}${elapsedSuffix}`);
      break;
    }
    case "running":
      // The Run was still going when the TUI closed (e.g. an abort that has not settled yet).
      lines.push(`◼ ship interrupted${elapsedSuffix}`);
      break;
  }

  // A Step tally by status (e.g. "9 done · 1 skipped · 1 failed"), so the scrollback shows progress.
  const order: ViewState["steps"][number]["status"][] = [
    "done",
    "skipped",
    "failed",
    "active",
    "pending",
  ];
  const counts = order
    .map((status) => [status, view.steps.filter((s) => s.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`);
  if (counts.length > 0) lines.push(`  ${counts.join(" · ")}`);

  if (view.prUrl !== undefined) lines.push(`  pr ${view.prUrl}`);
  return lines;
}
