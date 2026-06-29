// The `--watch` supervisor: a thin loop of Re-entries. `tml` runs the pipeline once to a ready PR
// (which parks - see `merge-gate` under watch), then this loop resumes the same Run on an interval,
// reconciling the PR against the moving base until it lands (merged/closed) or the operator quits.
// It is deliberately not a pipeline Step or a daemon (see docs/adr/0004): each tick is a resume
// Re-entry that replays the cheap local prefix from the journal and re-runs only the reconcile tail.

import type { RunOutcome } from "./isolated-run.ts";

export interface WatchLoopOptions {
  /** Whether watching is on. When false, the pipeline runs exactly once. */
  readonly enabled: boolean;
  /** Milliseconds to wait between ticks. */
  readonly intervalMs: number;
  /** Aborts the loop (Ctrl-C / TUI close); checked around the sleep. */
  readonly signal: AbortSignal;
  /** Run one tick (a fresh pipeline pass or a resume Re-entry); `tick` is 0-based. */
  readonly runTick: (tick: number) => Promise<RunOutcome>;
  /** Interruptible delay; injected in tests for a fake clock. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Notified before each rest, with the number of completed checks and the wait ahead. */
  readonly onWaiting?: (checks: number, nextCheckInMs: number) => void;
  /** Notified before each re-entry tick, with the number of checks already completed. */
  readonly onChecking?: (checks: number) => void;
}

/**
 * Run the pipeline, then - while watching is on and the Run keeps parking (a ready PR not yet
 * landed) - sleep and re-enter. Stops and returns the latest outcome when the Run no longer parks
 * (it landed, failed, or was cancelled) or the signal aborts. The first tick always runs.
 */
export async function runWatched(opts: WatchLoopOptions): Promise<RunOutcome> {
  let outcome = await opts.runTick(0);
  let tick = 1;
  while (opts.enabled && outcome.parked && !opts.signal.aborted) {
    opts.onWaiting?.(tick, opts.intervalMs); // `tick` == completed passes so far
    await opts.sleep(opts.intervalMs, opts.signal);
    if (opts.signal.aborted) return outcome;
    opts.onChecking?.(tick);
    outcome = await opts.runTick(tick);
    tick += 1;
  }
  return outcome;
}

/** Resolve after `ms`, or as soon as `signal` aborts (whichever comes first). Never rejects. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The effective watch decision. An explicit `--watch`/`--no-watch` flag wins; otherwise watch in an
 * interactive TTY (using the config default) and never without one - so an agent or CI invocation is
 * not pinned waiting for a human merge.
 */
export function resolveWatch(input: {
  readonly flag?: boolean;
  readonly configWatch?: boolean;
  readonly isTTY: boolean;
}): boolean {
  if (input.flag !== undefined) return input.flag;
  return input.isTTY ? (input.configWatch ?? false) : false;
}
