import { describe, expect, test } from "bun:test";
import { cancel, goto, isFlowSignal, retry, skip } from "../src/signals.ts";

describe("flow signal constructors", () => {
  test("skip", () => {
    expect(skip().kind).toBe("skip");
  });

  test("cancel carries an optional reason", () => {
    const c = cancel("ci red");
    expect(c.kind).toBe("cancel");
    expect((c as { reason?: string }).reason).toBe("ci red");
  });

  test("goto names a target Step", () => {
    const g = goto("lint");
    expect(g.kind).toBe("goto");
    expect((g as { step: string }).step).toBe("lint");
  });

  test("retry", () => {
    expect(retry().kind).toBe("retry");
  });
});

describe("isFlowSignal", () => {
  test("true for constructed signals", () => {
    expect(isFlowSignal(skip())).toBe(true);
    expect(isFlowSignal(cancel())).toBe(true);
    expect(isFlowSignal(goto("x"))).toBe(true);
    expect(isFlowSignal(retry())).toBe(true);
  });

  test("false for a plain look-alike record without the brand", () => {
    expect(isFlowSignal({ kind: "skip" })).toBe(false);
    expect(isFlowSignal({ kind: "goto", step: "lint" })).toBe(false);
  });

  test("false for non-objects", () => {
    expect(isFlowSignal(null)).toBe(false);
    expect(isFlowSignal("skip")).toBe(false);
    expect(isFlowSignal(undefined)).toBe(false);
  });

  test("the brand is non-enumerable, so it never leaks into the event/artifact shape", () => {
    expect(Object.keys(skip())).toEqual(["kind"]);
  });
});
