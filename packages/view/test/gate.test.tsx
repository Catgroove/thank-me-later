/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { RunMetadata } from "@tml/core";
import { type GateDecision, gateOptions } from "../src/gate.ts";
import { StartupGate } from "../src/tui/StartupGate.tsx";

const NOW = Date.parse("2026-06-28T12:00:00.000Z");

function run(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: "20260628113000-cafebabe",
    checkoutKey: "key",
    checkoutPath: "/repo",
    pipeline: ["produce"],
    status: "cancelled",
    startedAt: "2026-06-28T11:00:00.000Z",
    updatedAt: "2026-06-28T11:59:00.000Z",
    completedSteps: [],
    resumeKey: "feature-a",
    ...overrides,
  };
}

describe("gateOptions", () => {
  test("a parked run offers resume; a live run offers attach", () => {
    expect(gateOptions(false).map((o) => o.decision)).toEqual(["resume", "fresh", "list"]);
    expect(gateOptions(true).map((o) => o.decision)).toEqual(["attach", "fresh", "list"]);
  });
});

describe("StartupGate", () => {
  test("shows the candidate run and the parked-run options", async () => {
    const t = await testRender(
      () => StartupGate({ run: run(), live: false, now: NOW, onResolve: () => {} }),
      { width: 100, height: 24 },
    );
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("unfinished run for this branch");
    expect(frame).toContain("feature-a");
    expect(frame).toContain("cafebabe");
    expect(frame).toContain("resume");
    expect(frame).toContain("start fresh");
    expect(frame).toContain("list all runs");
    t.renderer.destroy();
  });

  test("a live run announces in-progress and offers attach", async () => {
    const t = await testRender(
      () =>
        StartupGate({
          run: run({ status: "running", owner: { pid: 4821, host: "h" } }),
          live: true,
          now: NOW,
          onResolve: () => {},
        }),
      { width: 100, height: 24 },
    );
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("already in progress");
    expect(frame).toContain("attach");
    expect(frame).toContain("pid 4821");
    t.renderer.destroy();
  });

  test("keys resolve the matching decision", async () => {
    let decision: GateDecision | undefined;
    const t = await testRender(
      () => StartupGate({ run: run(), live: false, now: NOW, onResolve: (d) => (decision = d) }),
      { width: 100, height: 24 },
    );
    await t.flush();
    t.mockInput.pressKey("r");
    await t.flush();
    expect(decision).toBe("resume");

    t.mockInput.pressKey("f");
    await t.flush();
    expect(decision).toBe("fresh");
    t.renderer.destroy();
  });

  test("enter takes the primary action", async () => {
    let decision: GateDecision | undefined;
    const t = await testRender(
      () =>
        StartupGate({
          run: run({ status: "running", owner: { pid: 1, host: "h" } }),
          live: true,
          now: NOW,
          onResolve: (d) => (decision = d),
        }),
      { width: 100, height: 24 },
    );
    await t.flush();
    t.mockInput.pressEnter();
    await t.flush();
    expect(decision).toBe("attach");
    t.renderer.destroy();
  });
});
