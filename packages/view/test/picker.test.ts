import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import type { RunMetadata } from "@tml/core";
import { defaultAction, initialPicker, pickerOnKey } from "../src/picker.ts";

const NOW = Date.parse("2026-06-28T12:00:00.000Z");

function run(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: "20260628110000-a1b2c3d4",
    checkoutKey: "key",
    checkoutPath: "/repo",
    pipeline: ["produce"],
    status: "finished",
    startedAt: "2026-06-28T11:00:00.000Z",
    updatedAt: "2026-06-28T11:59:50.000Z",
    completedSteps: [],
    ...overrides,
  };
}

describe("pickerOnKey", () => {
  test("moves and clamps within the list", () => {
    let state = initialPicker;
    expect(state.index).toBe(0);
    state = pickerOnKey(state, "k", 3); // already at top
    expect(state.index).toBe(0);
    state = pickerOnKey(state, "j", 3);
    state = pickerOnKey(state, "j", 3);
    expect(state.index).toBe(2);
    state = pickerOnKey(state, "j", 3); // clamp at bottom
    expect(state.index).toBe(2);
    expect(pickerOnKey(state, "g", 3).index).toBe(0);
    expect(pickerOnKey(initialPicker, "G", 3).index).toBe(2);
  });

  test("passes unknown keys through unchanged", () => {
    expect(pickerOnKey({ index: 1 }, "x", 3)).toEqual({ index: 1 });
  });
});

describe("defaultAction", () => {
  test("a finished run is viewed", () => {
    expect(defaultAction(run({ status: "finished" }), NOW)).toBe("view");
  });

  test("a live run is attached to, an orphaned one is resumed", () => {
    const live = run({ status: "running", owner: { pid: process.pid, host: hostname() } });
    expect(defaultAction(live, NOW)).toBe("attach");

    const orphan = run({ status: "running", owner: { pid: 999_999, host: hostname() } });
    expect(defaultAction(orphan, NOW)).toBe("resume");
  });

  test("a cancelled or failed run is resumed", () => {
    expect(defaultAction(run({ status: "cancelled" }), NOW)).toBe("resume");
    expect(defaultAction(run({ status: "failed" }), NOW)).toBe("resume");
  });
});
