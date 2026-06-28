/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { RunMetadata } from "@tml/core";
import type { PickerOutcome } from "../src/picker.ts";
import { RunList } from "../src/tui/RunList.tsx";

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

const RUNS = [
  run({ runId: "20260628113000-cafebabe", resumeKey: "feature-a", status: "cancelled" }),
  run({
    runId: "20260628100000-deadbeef",
    workspaceBranch: "feature-b",
    status: "finished",
    prUrl: "https://example/pull/7",
  }),
];

describe("RunList", () => {
  test("renders a row per run with state, branch, id, and PR", async () => {
    const t = await testRender(() => RunList({ runs: RUNS, now: NOW, onResolve: () => {} }), {
      width: 100,
      height: 24,
    });
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("tml runs");
    expect(frame).toContain("cancelled");
    expect(frame).toContain("feature-a");
    expect(frame).toContain("cafebabe");
    expect(frame).toContain("feature-b");
    expect(frame).toContain("https://example/pull/7");
    expect(frame).toContain("q quit");
    t.renderer.destroy();
  });

  test("enter resolves the selected run's default action", async () => {
    let outcome: PickerOutcome | undefined;
    const t = await testRender(
      () => RunList({ runs: RUNS, now: NOW, onResolve: (o) => (outcome = o) }),
      { width: 100, height: 24 },
    );
    await t.flush();
    // Move to the second run (finished) and open it: its default action is view.
    t.mockInput.pressKey("j");
    await t.flush();
    t.mockInput.pressEnter();
    await t.flush();

    expect(outcome?.kind).toBe("select");
    if (outcome?.kind === "select") {
      expect(outcome.run.runId).toContain("deadbeef");
      expect(outcome.action).toBe("view");
    }
    t.renderer.destroy();
  });

  test("q quits", async () => {
    let outcome: PickerOutcome | undefined;
    const t = await testRender(
      () => RunList({ runs: RUNS, now: NOW, onResolve: (o) => (outcome = o) }),
      { width: 100, height: 24 },
    );
    await t.flush();
    t.mockInput.pressKey("q");
    await t.flush();
    expect(outcome?.kind).toBe("quit");
    t.renderer.destroy();
  });
});
