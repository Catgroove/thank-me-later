// Liveness of a Run that is still marked `running`. A hard kill or crash skips the cancellation
// path, so a Run can sit at `running` forever with no live process behind it. The Run's recorded
// `owner` (pid + host) lets us tell a Run genuinely executing now apart from such an orphan, so the
// history list, the picker, and the startup gate can guide the user, and so `begin` can refuse to
// re-enter a Run another live process already holds.

import { hostname } from "node:os";
import type { RunMetadata } from "./run-journal.ts";

export type Liveness =
  /** Status `running`, owner process is alive on this host. */
  | "live"
  /** Owner process is gone (dead pid on this host, or stale beyond probing). Resumable. */
  | "orphaned"
  /** Status `running` on another host we cannot probe, with recent activity. Assume live elsewhere. */
  | "unknown";

export interface LivenessProbe {
  /** Current epoch milliseconds. */
  readonly now: number;
  /** Whether a pid is alive on this host. Injectable for tests; defaults to a `kill(pid, 0)` probe. */
  readonly isAlive?: (pid: number) => boolean;
  /** This machine's hostname. Injectable for tests; defaults to `os.hostname()`. */
  readonly host?: string;
}

// A `running` Run on another host (or a legacy Run with no owner) that has not touched its journal
// in this long is almost certainly dead. Same-host Runs are decided by the authoritative pid probe,
// not by this, so a long, quiet `ci-wait` on this machine is never misread as orphaned.
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

/**
 * Classify a Run's liveness. Meaningful only for `running` Runs; a terminal/parked Run has no live
 * owner and classifies as `orphaned` (callers branch on the terminal status before showing this).
 */
export function classifyLiveness(meta: RunMetadata, probe: LivenessProbe): Liveness {
  if (meta.status !== "running") return "orphaned";
  const isAlive = probe.isAlive ?? defaultIsAlive;
  const host = probe.host ?? hostname();
  const owner = meta.owner;
  if (owner === undefined) {
    // Legacy `running` Run with no recorded owner: we cannot probe, so fall back to staleness.
    return isStale(meta, probe.now) ? "orphaned" : "unknown";
  }
  if (owner.host === host) {
    return isAlive(owner.pid) ? "live" : "orphaned";
  }
  // A different host: its process table is out of reach. Recent activity means assume it runs there.
  return isStale(meta, probe.now) ? "orphaned" : "unknown";
}

function isStale(meta: RunMetadata, now: number): boolean {
  return now - Date.parse(meta.updatedAt) > STALE_RUNNING_MS;
}

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: the process exists but is not ours - still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
