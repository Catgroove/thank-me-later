// Pure aggregation of journaled runs into the figures `tml stats` reports. It speaks tml's own
// vocabulary: a *finding* is the smallest actionable observation a Step raises, and each finding
// settles into a lifecycle *outcome* (fixed, accepted as-is, unresolved, skipped, or left open). Both
// the outcome and the severity (disposition) come straight from the per-Step lifecycle fold
// (findingLifecycle), so stats can't drift from the finding states the rest of the tool derives.
// Findings that vanished without ever being acted on are dropped by that fold - `seen` counts the
// work that mattered, not noise.

import { basename } from "node:path";
import {
  type FindingDisposition,
  type FindingStatus,
  findingLifecycle,
  type RoundRecord,
} from "./round.ts";
import type { RunHistoryEntry } from "./run-history.ts";

/** How the findings that mattered settled, by lifecycle status. */
export interface OutcomeTally {
  readonly fixed: number;
  readonly accepted: number;
  readonly unresolved: number;
  readonly skipped: number;
  readonly open: number;
}

/** Counts of seen findings by severity (disposition). */
export type SeverityTally = Record<FindingDisposition, number>;

export interface StepStats {
  readonly step: string;
  readonly seen: number;
  readonly fixed: number;
  readonly outcomes: OutcomeTally;
}

export interface RepoStats {
  readonly repo: string;
  readonly runs: number;
  readonly seen: number;
  readonly fixed: number;
}

export interface SummarizeOptions {
  /**
   * Map a checkout path to the repo it belongs to, so every clone and worktree of one repo folds
   * into a single row. Defaults to the path's directory name; callers that can resolve the git
   * remote pass that instead.
   */
  readonly repoOf?: (checkoutPath: string) => string;
}

export interface RunStats {
  readonly runs: number;
  readonly repos: number;
  readonly findingsSeen: number;
  readonly findingsFixed: number;
  /** Fixed / seen in `[0, 1]`; 0 when nothing was seen. */
  readonly fixRate: number;
  /** The whole-history lifecycle breakdown. */
  readonly outcomes: OutcomeTally;
  /** Seen findings by severity. */
  readonly bySeverity: SeverityTally;
  /** Per-Step contribution, most findings seen first. */
  readonly byStep: readonly StepStats[];
  /** One row per repo, most fixes first. */
  readonly topRepos: readonly RepoStats[];
}

interface MutableOutcomes {
  fixed: number;
  accepted: number;
  unresolved: number;
  skipped: number;
  open: number;
}

export function summarizeRunStats(
  entries: readonly RunHistoryEntry[],
  opts: SummarizeOptions = {},
): RunStats {
  const repoOf = opts.repoOf ?? ((path: string) => basename(path) || path);
  const outcomes = emptyOutcomes();
  const severity: SeverityTally = { blocker: 0, "should-fix": 0, consider: 0, nit: 0 };
  const steps = new Map<string, { seen: number; outcomes: MutableOutcomes }>();
  const repos = new Map<string, { runs: number; seen: number; fixed: number }>();
  let findingsSeen = 0;

  for (const entry of entries) {
    let runSeen = 0;
    let runFixed = 0;
    for (const [step, rounds] of roundsByStep(entry.rounds)) {
      const tally = steps.get(step) ?? { seen: 0, outcomes: emptyOutcomes() };
      for (const { finding, status } of findingLifecycle(rounds, { settled: true })) {
        findingsSeen += 1;
        runSeen += 1;
        // Findings journaled before the disposition field existed have none; they still count as
        // seen, but there is no severity to credit, so the severity chips sum to <= seen on old data.
        if (Object.hasOwn(severity, finding.disposition)) severity[finding.disposition] += 1;
        addOutcome(outcomes, status);
        tally.seen += 1;
        addOutcome(tally.outcomes, status);
        if (status === "fixed") runFixed += 1;
      }
      steps.set(step, tally);
    }
    const repo = repoOf(entry.metadata.checkoutPath);
    const r = repos.get(repo) ?? { runs: 0, seen: 0, fixed: 0 };
    r.runs += 1;
    r.seen += runSeen;
    r.fixed += runFixed;
    repos.set(repo, r);
  }

  return {
    runs: entries.length,
    repos: repos.size,
    findingsSeen,
    findingsFixed: outcomes.fixed,
    fixRate: findingsSeen === 0 ? 0 : outcomes.fixed / findingsSeen,
    outcomes,
    bySeverity: severity,
    byStep: [...steps.entries()]
      .map(([step, s]) => ({ step, seen: s.seen, fixed: s.outcomes.fixed, outcomes: s.outcomes }))
      .sort((a, b) => b.seen - a.seen || b.fixed - a.fixed || a.step.localeCompare(b.step)),
    topRepos: [...repos.entries()]
      .map(([repo, r]) => ({ repo, runs: r.runs, seen: r.seen, fixed: r.fixed }))
      .sort((a, b) => b.fixed - a.fixed || b.seen - a.seen || a.repo.localeCompare(b.repo)),
  };
}

function emptyOutcomes(): MutableOutcomes {
  return { fixed: 0, accepted: 0, unresolved: 0, skipped: 0, open: 0 };
}

// A settled fold yields open/fixed/unresolved/accepted/skipped; `pending` should not survive
// settling, but fold it into unresolved defensively so no finding is silently dropped.
function addOutcome(tally: MutableOutcomes, status: FindingStatus): void {
  switch (status) {
    case "fixed":
      tally.fixed += 1;
      break;
    case "accepted":
      tally.accepted += 1;
      break;
    case "skipped":
      tally.skipped += 1;
      break;
    case "open":
      tally.open += 1;
      break;
    default:
      tally.unresolved += 1;
  }
}

function roundsByStep(rounds: readonly RoundRecord[]): Map<string, RoundRecord[]> {
  const byStep = new Map<string, RoundRecord[]>();
  for (const round of rounds) {
    const group = byStep.get(round.step) ?? [];
    group.push(round);
    byStep.set(round.step, group);
  }
  return byStep;
}
