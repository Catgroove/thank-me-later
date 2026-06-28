// Render an aggregated `RunStats` into a terminal block: a block-letter banner, headline figures,
// fixes credited per Step, and a per-repo table - each numeric row trailed by a horizontal gauge.
// Pure string assembly; the `tml stats` command owns reading history and choosing whether to color.

import type { RunStats } from "@tml/core";
import { makeStyle, type Style } from "./ansi.ts";
import { bannerLines } from "./banner.ts";

export interface RenderStatsOptions {
  /** ANSI color; defaults off so piped/captured output stays plain. */
  readonly color?: boolean;
  /** Banner text; defaults to the tool name. */
  readonly title?: string;
}

const BAR_WIDTH = 24;
const MIN_LABEL_WIDTH = 12;
const MAX_LABEL_WIDTH = 28;
const VALUE_WIDTH = 5;
const TOP_REPOS = 8;

export function renderStats(stats: RunStats, options: RenderStatsOptions = {}): string {
  const style = makeStyle(options.color ?? false);
  const banner = bannerLines(options.title ?? "THANK ME LATER").map((line) => style.green(line));

  if (stats.runs === 0) {
    return [...banner, "", style.dim("No runs recorded yet. Run tml to get started.")].join("\n");
  }

  const withFixes = stats.topRepos.filter((r) => r.fixed > 0);
  const topRepos = withFixes.slice(0, TOP_REPOS);
  const labelWidth = clampLabelWidth([
    "Runs",
    "Findings",
    "Fixed",
    ...stats.fixesByStep.map((s) => s.step),
    ...topRepos.map((r) => r.repo),
  ]);
  const row = (label: string, value: string, trail?: string): string =>
    `${fit(label, labelWidth)}${style.bold(value.padStart(VALUE_WIDTH))}${trail ? `  ${trail}` : ""}`;

  const lines: string[] = [...banner, ""];

  lines.push(
    row(
      "Runs",
      String(stats.runs),
      style.dim(`across ${stats.repos} ${plural(stats.repos, "repo")}`),
    ),
  );
  lines.push(row("Findings", String(stats.findingsReported)));
  lines.push(
    row(
      "Fixed",
      String(stats.findingsFixed),
      `${gauge(style, stats.fixRate, 1)}  ${style.dim(`${pct(stats.fixRate)}%`)}`,
    ),
  );

  if (stats.fixesByStep.length > 0) {
    const max = stats.fixesByStep[0].fixed; // sorted desc
    lines.push("", style.bold("Fixes by step"));
    for (const s of stats.fixesByStep) {
      lines.push(row(s.step, String(s.fixed), gauge(style, s.fixed, max)));
    }
  }

  if (topRepos.length > 0) {
    const max = Math.max(...topRepos.map((r) => r.fixed), 1);
    lines.push("", style.bold("Top repos"));
    for (const r of topRepos) {
      const runs = style.dim(`${r.runs} ${plural(r.runs, "run")}`);
      lines.push(row(r.repo, String(r.fixed), `${gauge(style, r.fixed, max)}  ${runs}`));
    }
    const more = withFixes.length - topRepos.length;
    if (more > 0) lines.push(style.dim(`+${more} more`));
  }

  return lines.join("\n");
}

function clampLabelWidth(labels: readonly string[]): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.min(MAX_LABEL_WIDTH, Math.max(MIN_LABEL_WIDTH, longest + 2));
}

/** Pad a label to `width`, or truncate with an ellipsis so over-long names keep the bars aligned. */
function fit(label: string, width: number): string {
  if (label.length <= width) return label.padEnd(width);
  return `${label.slice(0, width - 2)}… `;
}

/** A horizontal gauge: green fill over a dim track, `value` of `max`. */
function gauge(style: Style, value: number, max: number, width = BAR_WIDTH): string {
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const filled = Math.round(ratio * width);
  const head = filled > 0 ? style.green("█".repeat(filled)) : "";
  const tail = filled < width ? style.dim("░".repeat(width - filled)) : "";
  return head + tail;
}

function pct(ratio: number): number {
  return Math.round(ratio * 100);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm;
}
