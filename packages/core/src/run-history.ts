// Read-only history reader over the run journal's on-disk layout. The journal (run-journal.ts) owns
// how runs are written; this module owns reading them back across one or all checkouts, so callers
// (e.g. `tml stats`) never hardcode where state lives. A single unreadable run is skipped rather than
// failing the whole scan - history is best-effort reporting, not the authoritative run record.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoundRecord } from "./round.ts";
import {
  checkoutKeyForPath,
  defaultStateHome,
  parseRounds,
  readMetadataIfExists,
  type RunMetadata,
} from "./run-journal.ts";

export interface RunHistoryEntry {
  readonly metadata: RunMetadata;
  readonly rounds: readonly RoundRecord[];
}

export interface ReadRunHistoryOptions {
  /** "all" scans every checkout under the state home; "checkout" only the one for `checkoutPath`. */
  readonly scope?: "all" | "checkout";
  /** Checkout to scope to when `scope` is "checkout". Defaults to process.cwd(). */
  readonly checkoutPath?: string;
  /** Override the XDG state root in tests. Defaults to $XDG_STATE_HOME or ~/.local/state. */
  readonly stateHome?: string;
  /** Environment lookup for XDG_STATE_HOME. Defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
}

/** Read journaled runs, newest first. Empty when nothing has been journaled yet. */
export async function readRunHistory(opts: ReadRunHistoryOptions = {}): Promise<RunHistoryEntry[]> {
  const env = opts.env ?? process.env;
  const tmlRoot = join(opts.stateHome ?? defaultStateHome(env), "tml");
  if (!existsSync(tmlRoot)) return [];

  const scope = opts.scope ?? "all";
  const checkoutKeys =
    scope === "checkout"
      ? [checkoutKeyForPath(opts.checkoutPath ?? process.cwd())]
      : await readdir(tmlRoot);

  const entries: RunHistoryEntry[] = [];
  for (const key of checkoutKeys) {
    const runsDir = join(tmlRoot, key, "runs");
    if (!existsSync(runsDir)) continue;
    for (const runId of await readdir(runsDir)) {
      const entry = await readRunEntry(join(runsDir, runId));
      if (entry !== undefined) entries.push(entry);
    }
  }
  entries.sort((a, b) => b.metadata.startedAt.localeCompare(a.metadata.startedAt));
  return entries;
}

async function readRunEntry(runDir: string): Promise<RunHistoryEntry | undefined> {
  try {
    const metadata = await readMetadataIfExists(runDir);
    if (metadata === undefined) return undefined;
    const roundsPath = join(runDir, "rounds.jsonl");
    const rounds = existsSync(roundsPath) ? parseRounds(await readFile(roundsPath, "utf8")) : [];
    return { metadata, rounds };
  } catch {
    return undefined;
  }
}
