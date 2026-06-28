// Pure aggregation of journaled runs into the figures `tml stats` reports. It speaks tml's own
// vocabulary: a *finding* is the smallest actionable observation a Step raises, and a finding is
// *fixed* when a later verification pass no longer reports it. Both come straight from the existing
// per-Step lifecycle fold (findingLifecycle), so stats can't drift from the finding states the rest
// of the tool derives. Findings that vanished without ever being acted on are dropped by that fold -
// reported counts the work that mattered, not noise.

import { basename } from "node:path";
import { findingLifecycle, type RoundRecord } from "./round.ts";
import type { RunHistoryEntry } from "./run-history.ts";

export interface StepFixes {
  readonly step: string;
  readonly fixed: number;
}

export interface RepoStats {
  readonly repo: string;
  readonly runs: number;
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
  readonly findingsReported: number;
  readonly findingsFixed: number;
  /** Fixed / reported in `[0, 1]`; 0 when nothing was reported. */
  readonly fixRate: number;
  /** Fixes credited to each Step, most fixes first. */
  readonly fixesByStep: readonly StepFixes[];
  /** One row per checkout, most fixes first. */
  readonly topRepos: readonly RepoStats[];
}

export function summarizeRunStats(
  entries: readonly RunHistoryEntry[],
  opts: SummarizeOptions = {},
): RunStats {
  const repoOf = opts.repoOf ?? ((path: string) => basename(path) || path);
  let findingsReported = 0;
  let findingsFixed = 0;
  const fixesByStep = new Map<string, number>();
  const repos = new Map<string, { runs: number; fixed: number }>();

  for (const entry of entries) {
    let runFixed = 0;
    for (const [step, rounds] of roundsByStep(entry.rounds)) {
      for (const { status } of findingLifecycle(rounds, { settled: true })) {
        findingsReported += 1;
        if (status === "fixed") {
          findingsFixed += 1;
          runFixed += 1;
          fixesByStep.set(step, (fixesByStep.get(step) ?? 0) + 1);
        }
      }
    }
    const repo = repoOf(entry.metadata.checkoutPath);
    const stats = repos.get(repo) ?? { runs: 0, fixed: 0 };
    stats.runs += 1;
    stats.fixed += runFixed;
    repos.set(repo, stats);
  }

  return {
    runs: entries.length,
    repos: repos.size,
    findingsReported,
    findingsFixed,
    fixRate: findingsReported === 0 ? 0 : findingsFixed / findingsReported,
    fixesByStep: [...fixesByStep.entries()]
      .map(([step, fixed]) => ({ step, fixed }))
      .sort((a, b) => b.fixed - a.fixed || a.step.localeCompare(b.step)),
    topRepos: [...repos.entries()]
      .map(([repo, r]) => ({ repo, runs: r.runs, fixed: r.fixed }))
      .sort((a, b) => b.fixed - a.fixed || b.runs - a.runs || a.repo.localeCompare(b.repo)),
  };
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
