// Render an aggregated `RunStats` as a lifetime view of the pipeline, in tml's own visual language:
// the `▶` header and `─` rule of the run renderer, the finding-lifecycle glyphs (`✓` fixed/accepted,
// `✗` unresolved, `⤼` skipped, `○` open) and `·`-joined tally chips of the rail and findings
// inspector, the `▸` step glyph of the pipeline rail, and the `[disposition]` severity markers. No
// banner, no bar charts - a stats screen that reads like the rest of the tool. Pure string assembly;
// the `tml stats` command owns reading history and choosing whether to color.

import type { OutcomeTally, RunStats, StepStats } from "@tml/core";
import { makeStyle, type Style } from "./ansi.ts";

export interface RenderStatsOptions {
  /** ANSI color; defaults off so piped/captured output stays plain. */
  readonly color?: boolean;
}

const HEADER = "▶ stats";
const STEP_GLYPH = "▸";
const INDENT = "  ";
const TOP_REPOS = 8;
const MAX_NAME = 24;

interface OutcomeMeta {
  readonly key: keyof OutcomeTally;
  readonly glyph: string;
  readonly label: string;
  readonly tone: keyof Pick<Style, "green" | "red" | "dim">;
}

// Lifecycle outcomes in narrative order: what got resolved well, then what did not, then what was
// left. Glyphs and colors mirror the rail/inspector's STATUS_META so the two never read differently.
const OUTCOMES: readonly OutcomeMeta[] = [
  { key: "fixed", glyph: "✓", label: "fixed", tone: "green" },
  { key: "accepted", glyph: "✓", label: "accepted", tone: "green" },
  { key: "unresolved", glyph: "✗", label: "unresolved", tone: "red" },
  { key: "skipped", glyph: "⤼", label: "skipped", tone: "dim" },
  { key: "open", glyph: "○", label: "open", tone: "dim" },
];

const SEVERITY: readonly {
  readonly key: keyof RunStats["bySeverity"];
  readonly tone: keyof Pick<Style, "red" | "yellow" | "cyan" | "dim">;
}[] = [
  { key: "blocker", tone: "red" },
  { key: "should-fix", tone: "yellow" },
  { key: "consider", tone: "cyan" },
  { key: "nit", tone: "dim" },
];

export function renderStats(stats: RunStats, options: RenderStatsOptions = {}): string {
  const style = makeStyle(options.color ?? false);

  if (stats.runs === 0) {
    return [style.bold(HEADER), style.dim("no runs recorded yet · run tml to get started")].join(
      "\n",
    );
  }

  const context = `${repoContext(stats)} · ${stats.runs} ${plural(stats.runs, "run")}`;
  const header = `${style.bold(HEADER)} ${style.dim(`· ${context}`)}`;
  const lines: string[] = [header, style.dim("─".repeat(HEADER.length + context.length + 3)), ""];

  // Headline: one line of the whole story.
  lines.push(
    `${INDENT}${style.bold(String(stats.findingsSeen))} findings seen${style.dim(" · ")}` +
      `${style.bold(String(stats.findingsFixed))} fixed${style.dim(" · ")}` +
      `${style.dim(`${pct(stats.fixRate)}% fix rate`)}`,
  );

  // Lifecycle breakdown as labeled tally chips.
  const breakdown = outcomeChips(style, stats.outcomes);
  if (breakdown !== "") lines.push("", `${INDENT}${breakdown}`);

  // Severity mix.
  const severity = severityChips(style, stats.bySeverity);
  if (severity !== "") lines.push("", `${INDENT}${style.dim("severity")}  ${severity}`);

  // The pipeline itself: each step's lifetime contribution.
  if (stats.byStep.length > 0) {
    lines.push("", `${INDENT}${style.dim("pipeline")}`);
    lines.push(...stepLines(style, stats.byStep));
  }

  // Repos, when more than one is in play (otherwise it just repeats the header).
  if (stats.repos > 1) {
    const withFixes = stats.topRepos.filter((r) => r.fixed > 0);
    const shown = withFixes.slice(0, TOP_REPOS);
    if (shown.length > 0) {
      lines.push("", `${INDENT}${style.dim("repos")}`);
      const names = shown.map((r) => shortRepo(r.repo));
      const nameWidth = Math.min(MAX_NAME, Math.max(...names.map((n) => n.length)));
      shown.forEach((r, i) => {
        const runs = style.dim(`· ${r.runs} ${plural(r.runs, "run")}`);
        lines.push(
          `${INDENT}${fit(names[i], nameWidth)}  ${style.green(`✓ ${r.fixed} fixed`)}  ${runs}`,
        );
      });
      const more = withFixes.length - shown.length;
      if (more > 0) lines.push(`${INDENT}${style.dim(`+${more} more`)}`);
    }
  }

  return lines.join("\n");
}

function stepLines(style: Style, byStep: readonly StepStats[]): string[] {
  const nameWidth = Math.min(MAX_NAME, Math.max(...byStep.map((s) => s.step.length)));
  const seenWidth = Math.max(...byStep.map((s) => String(s.seen).length));
  return byStep.map((s) => {
    const name = fit(s.step, nameWidth);
    const seen = style.dim(`${String(s.seen).padStart(seenWidth)} seen`);
    const chips: string[] = [];
    if (s.fixed > 0) chips.push(style.green(`✓ ${s.fixed} fixed`));
    if (s.outcomes.unresolved > 0) chips.push(style.red(`✗ ${s.outcomes.unresolved}`));
    const trail = chips.length > 0 ? `  ${chips.join("  ")}` : "";
    return `${INDENT}${STEP_GLYPH} ${name}  ${seen}${trail}`;
  });
}

/** `glyph count label · …` chips for the nonzero lifecycle buckets, in narrative order. */
function outcomeChips(style: Style, outcomes: OutcomeTally): string {
  return OUTCOMES.filter((o) => outcomes[o.key] > 0)
    .map((o) => `${style[o.tone](o.glyph)} ${outcomes[o.key]} ${o.label}`)
    .join(style.dim(" · "));
}

function severityChips(style: Style, severity: RunStats["bySeverity"]): string {
  return SEVERITY.filter((s) => severity[s.key] > 0)
    .map((s) => `${style[s.tone](`[${s.key}]`)} ${severity[s.key]}`)
    .join(style.dim(" · "));
}

function repoContext(stats: RunStats): string {
  if (stats.repos === 1 && stats.topRepos[0] !== undefined)
    return shortRepo(stats.topRepos[0].repo);
  return `${stats.repos} repos`;
}

/** Display form of a repo identity: its `owner/repo` tail, dropping the host. */
function shortRepo(identity: string): string {
  const segments = identity.split("/").filter((s) => s !== "");
  return segments.slice(-2).join("/") || identity;
}

/** Pad a name to `width`, or truncate with an ellipsis so trailing columns stay aligned. */
function fit(name: string, width: number): string {
  if (name.length <= width) return name.padEnd(width);
  return `${name.slice(0, width - 1)}…`;
}

function pct(ratio: number): number {
  return Math.round(ratio * 100);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm;
}
