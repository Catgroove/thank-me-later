import { describe, expect, test } from "bun:test";
import { type Pending, TimeoutError, until } from "../src/pending.ts";

/** A Pending that settles to `value` on its Nth poll, counting calls. */
function settlesAfter<T>(polls: number, value: T) {
  let calls = 0;
  const pending: Pending<T> = {
    poll() {
      calls += 1;
      return Promise.resolve(calls >= polls ? { done: true, value } : { done: false });
    },
  };
  return { pending, calls: () => calls };
}

const never: Pending<never> = { poll: () => Promise.resolve({ done: false }) };

describe("until", () => {
  test("returns the value once the Pending settles", async () => {
    const { pending, calls } = settlesAfter(3, "ok");
    expect(await until(pending, { every: 1 })).toBe("ok");
    expect(calls()).toBe(3);
  });

  test("resolves on the first poll when already settled (no wait)", async () => {
    const { pending, calls } = settlesAfter(1, 42);
    expect(await until(pending)).toBe(42);
    expect(calls()).toBe(1);
  });

  test("throws TimeoutError when it never settles within the timeout", async () => {
    let caught: unknown;
    try {
      await until(never, { every: 1, timeout: 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
  });
});
