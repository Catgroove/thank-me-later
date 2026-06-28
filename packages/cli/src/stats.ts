// `tml stats` - aggregate the local run journal into a glanceable summary. Scans every checkout's
// runs by default (the journal records one machine's work across repos); `--here` narrows to the
// current checkout. Color follows the same rule as the pipeline renderer: on for a real, color-capable
// TTY unless NO_COLOR is set. `--json` emits the raw figures for scripting. Side effects (history
// read, output) are injected so the flow is testable without touching the filesystem.

import { readRunHistory, type RunStats, summarizeRunStats } from "@tml/core";
import { renderStats } from "@tml/view";
import { errorMessage } from "./error.ts";
import { resolveRepoNames } from "./repo-identity.ts";

export interface StatsArgs {
  /** Restrict to the current checkout instead of every repo on this machine. */
  readonly here?: boolean;
  /** Emit the aggregated figures as JSON instead of the rendered summary. */
  readonly json?: boolean;
}

export interface StatsDeps {
  readonly cwd?: string;
  readonly read?: typeof readRunHistory;
  readonly resolveRepos?: typeof resolveRepoNames;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  /** Force color on/off; defaults to the TTY/NO_COLOR heuristic. */
  readonly color?: boolean;
}

export async function stats(args: StatsArgs = {}, deps: StatsDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const read = deps.read ?? readRunHistory;
  const resolveRepos = deps.resolveRepos ?? resolveRepoNames;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  try {
    const entries = await read(
      args.here ? { scope: "checkout", checkoutPath: cwd } : { scope: "all" },
    );
    const repoNames = await resolveRepos(entries.map((entry) => entry.metadata.checkoutPath));
    const summary = summarizeRunStats(entries, {
      repoOf: (path) => repoNames.get(path) ?? path,
    });
    log(args.json ? toJson(summary) : renderStats(summary, { color: resolveColor(deps.color) }));
    return 0;
  } catch (caught) {
    error(`tml stats: ${errorMessage(caught)}`);
    return 1;
  }
}

function resolveColor(forced: boolean | undefined): boolean {
  if (forced !== undefined) return forced;
  return process.env.NO_COLOR === undefined && !!process.stdout.isTTY;
}

function toJson(summary: RunStats): string {
  return JSON.stringify(summary, null, 2);
}
