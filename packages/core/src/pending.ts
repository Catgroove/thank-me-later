// Eventually-consistent results and the single primitive that drives them
// (ADR-0005). Synchronous Provider operations just return a Promise; only
// operations that settle over time — CI checks, an agent task finishing, a PR
// becoming mergeable — return a Pending, which `until` polls to resolution. The
// sync/async/pollable distinction therefore lives in the *result type*, not in
// a per-Provider loop.

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

const DEFAULT_EVERY = 1_000;
const DEFAULT_TIMEOUT = 300_000;

/**
 * Poll a {@link Pending} until it settles, then return its value. Throws
 * {@link TimeoutError} once `timeout` ms elapse without settling. Engine-owned;
 * also surfaced to Steps as `ctx.until`.
 */
export async function until<T>(
  pending: Pending<T>,
  opts: { every?: number; timeout?: number } = {},
): Promise<T> {
  const every = opts.every ?? DEFAULT_EVERY;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const deadline = Date.now() + timeout;

  for (;;) {
    const result = await pending.poll();
    if (result.done) return result.value;
    if (Date.now() >= deadline) throw new TimeoutError();
    await sleep(every);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
