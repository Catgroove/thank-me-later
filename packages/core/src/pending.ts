// Eventually-consistent results and the single primitive that drives them.
// Synchronous Provider operations just return a Promise; only
// operations that settle over time — CI checks, an agent task finishing, a PR
// becoming mergeable — return a Pending, which `until` polls to resolution. The
// sync/async/pollable distinction therefore lives in the *result type*, not in
// a per-Provider loop.
//
// `until` is abort-aware: an `AbortSignal` stops it promptly —
// mid-sleep, not just between polls — so a long Provider wait can be cancelled.

import { setTimeout as delay } from "node:timers/promises";

export type PollResult<T> = { done: true; value: T } | { done: false };

export interface Pending<T> {
  /** One cheap, side-effect-light check for whether the result has settled. */
  poll(): Promise<PollResult<T>>;
}

export class TimeoutError extends Error {
  constructor(message = "until() timed out before the operation settled") {
    super(message);
    this.name = "TimeoutError";
  }
}

export class AbortError extends Error {
  constructor(message = "until() was aborted before the operation settled") {
    super(message);
    this.name = "AbortError";
  }
}

const DEFAULT_EVERY = 1_000;
const DEFAULT_TIMEOUT = 300_000;

/**
 * Poll a {@link Pending} until it settles, then return its value. Throws
 * {@link TimeoutError} once `timeout` ms elapse without settling, or
 * {@link AbortError} if `signal` aborts first. Engine-owned; also surfaced to
 * Steps as `ctx.until` (the engine injects `ctx.signal`).
 */
export async function until<T>(
  pending: Pending<T>,
  opts: { every?: number; timeout?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const every = opts.every ?? DEFAULT_EVERY;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const signal = opts.signal;
  const deadline = Date.now() + timeout;

  if (signal?.aborted) throw new AbortError();

  for (;;) {
    const result = await pending.poll();
    if (result.done) return result.value;
    if (signal?.aborted) throw new AbortError();
    if (Date.now() >= deadline) throw new TimeoutError();
    await sleep(every, signal);
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw new AbortError();
    throw error;
  }
}
