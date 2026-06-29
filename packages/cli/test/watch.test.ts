import { describe, expect, test } from "bun:test";
import type { RunOutcome } from "../src/isolated-run.ts";
import { abortableSleep, resolveWatch, runWatched } from "../src/watch.ts";

const outcome = (o: Partial<RunOutcome>): RunOutcome => ({
  failed: false,
  cancelled: false,
  finished: false,
  parked: false,
  ...o,
});

/** A fake sleep that records each wait and can trip an abort to exercise the quit path. */
function fakeSleep(opts: { abortOn?: number; controller?: AbortController } = {}) {
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    if (waits.length === opts.abortOn) opts.controller?.abort();
    waits.push(ms);
    return Promise.resolve();
  };
  return { sleep, waits };
}

describe("runWatched", () => {
  test("runs exactly once when watching is off", async () => {
    const signal = new AbortController().signal;
    const ticks: number[] = [];
    const { sleep, waits } = fakeSleep();
    const result = await runWatched({
      enabled: false,
      intervalMs: 1000,
      signal,
      sleep,
      runTick: (tick) => {
        ticks.push(tick);
        return Promise.resolve(outcome({ parked: true })); // parked, but watching is off
      },
    });
    expect(ticks).toEqual([0]);
    expect(waits).toEqual([]);
    expect(result.parked).toBe(true);
  });

  test("does not loop when the first tick lands", async () => {
    const signal = new AbortController().signal;
    const ticks: number[] = [];
    const { sleep, waits } = fakeSleep();
    const result = await runWatched({
      enabled: true,
      intervalMs: 1000,
      signal,
      sleep,
      runTick: (tick) => {
        ticks.push(tick);
        return Promise.resolve(outcome({ finished: true }));
      },
    });
    expect(ticks).toEqual([0]);
    expect(waits).toEqual([]);
    expect(result.finished).toBe(true);
  });

  test("loops while the PR keeps parking, until a tick lands", async () => {
    const signal = new AbortController().signal;
    const ticks: number[] = [];
    const { sleep, waits } = fakeSleep();
    // Parked for ticks 0 and 1 (base moved, reconciled), landed on tick 2.
    const results = [
      outcome({ parked: true }),
      outcome({ parked: true }),
      outcome({ finished: true }),
    ];
    const result = await runWatched({
      enabled: true,
      intervalMs: 1000,
      signal,
      sleep,
      runTick: (tick) => {
        ticks.push(tick);
        return Promise.resolve(results[tick] as RunOutcome);
      },
    });
    expect(ticks).toEqual([0, 1, 2]); // re-entered twice
    expect(waits).toEqual([1000, 1000]); // one sleep before each re-entry
    expect(result.finished).toBe(true);
  });

  test("notifies onWaiting before each rest and onChecking before each re-entry", async () => {
    const signal = new AbortController().signal;
    const { sleep } = fakeSleep();
    const waiting: number[] = [];
    const checking: number[] = [];
    const results = [
      outcome({ parked: true }),
      outcome({ parked: true }),
      outcome({ finished: true }),
    ];
    await runWatched({
      enabled: true,
      intervalMs: 1000,
      signal,
      sleep,
      runTick: (tick) => Promise.resolve(results[tick] as RunOutcome),
      onWaiting: (checks) => waiting.push(checks),
      onChecking: (checks) => checking.push(checks),
    });
    // Two rests (after the parked ticks 0 and 1), reporting the running completed count each time.
    expect(waiting).toEqual([1, 2]);
    expect(checking).toEqual([1, 2]);
  });

  test("stops looping when aborted during the sleep (quit while parked)", async () => {
    const controller = new AbortController();
    const ticks: number[] = [];
    const { sleep, waits } = fakeSleep({ abortOn: 0, controller });
    const result = await runWatched({
      enabled: true,
      intervalMs: 1000,
      signal: controller.signal,
      sleep,
      runTick: (tick) => {
        ticks.push(tick);
        return Promise.resolve(outcome({ parked: true })); // never lands
      },
    });
    // Tick 0 parked → sleep (which aborts) → loop sees the abort and returns the parked outcome.
    expect(ticks).toEqual([0]);
    expect(waits).toEqual([1000]);
    expect(result.parked).toBe(true);
  });
});

describe("resolveWatch", () => {
  test("an explicit flag wins over config and TTY", () => {
    expect(resolveWatch({ flag: true, configWatch: false, isTTY: false })).toBe(true);
    expect(resolveWatch({ flag: false, configWatch: true, isTTY: true })).toBe(false);
  });

  test("without a flag, watches in a TTY using the config default", () => {
    expect(resolveWatch({ configWatch: true, isTTY: true })).toBe(true);
    expect(resolveWatch({ configWatch: false, isTTY: true })).toBe(false);
    expect(resolveWatch({ isTTY: true })).toBe(false); // unset config defaults off
  });

  test("without a flag and without a TTY, never watches (don't pin an agent/CI)", () => {
    expect(resolveWatch({ configWatch: true, isTTY: false })).toBe(false);
    expect(resolveWatch({ isTTY: false })).toBe(false);
  });
});

describe("abortableSleep", () => {
  test("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await abortableSleep(100_000, controller.signal); // would hang for ~28h if not abort-aware
  });

  test("resolves as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const slept = abortableSleep(100_000, controller.signal);
    controller.abort();
    await slept;
  });
});
