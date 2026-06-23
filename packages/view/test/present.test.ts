import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@tml/core";
import { initialView, present, type ViewState } from "../src/present.ts";

/** Fold a whole sequence, as `ship()` does. */
const fold = (events: RunEvent[]): ViewState => events.reduce(present, initialView);

describe("present", () => {
  test("run:started seeds the steps in pipeline order, all pending", () => {
    const view = fold([{ type: "run:started", pipeline: ["branch", "lint", "test"] }]);
    expect(view.steps).toEqual([
      { name: "branch", status: "pending" },
      { name: "lint", status: "pending" },
      { name: "test", status: "pending" },
    ]);
    expect(view.status).toBe("running");
    expect(view.activeStep).toBeUndefined();
  });

  test("step:started activates the step and resets text + tool + logs", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "agent:progress", step: "lint", progress: { kind: "text", text: "stale" } },
      { type: "step:log", step: "lint", message: "stale log" },
      { type: "step:started", step: "lint" },
    ]);
    expect(view.activeStep).toBe("lint");
    expect(view.steps[0]).toEqual({ name: "lint", status: "active" });
    expect(view.text).toBe("");
    expect(view.tool).toBeUndefined();
    expect(view.logs).toEqual([]);
  });

  test("agent:progress text deltas coalesce into the active step's buffer", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
      { type: "agent:progress", step: "lint", progress: { kind: "text", text: "Ran " } },
      { type: "agent:progress", step: "lint", progress: { kind: "text", text: "the checks" } },
    ]);
    expect(view.text).toBe("Ran the checks");
  });

  test("a tool start sets tool (with detail); a tool end clears it", () => {
    const afterStart = fold([
      { type: "run:started", pipeline: ["format"] },
      { type: "step:started", step: "format" },
      {
        type: "agent:progress",
        step: "format",
        progress: { kind: "tool", name: "bash", phase: "start", detail: "bun run fmt" },
      },
    ]);
    expect(afterStart.tool).toEqual({ name: "bash", detail: "bun run fmt" });

    const afterEnd = present(afterStart, {
      type: "agent:progress",
      step: "format",
      progress: { kind: "tool", name: "bash", phase: "end" },
    });
    expect(afterEnd.tool).toBeUndefined();
  });

  test("happy path: steps resolve to done and the run finishes", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint", "test"] },
      { type: "step:started", step: "lint" },
      { type: "step:finished", step: "lint" },
      { type: "step:started", step: "test" },
      { type: "step:finished", step: "test" },
      { type: "run:finished" },
    ]);
    expect(view.steps).toEqual([
      { name: "lint", status: "done" },
      { name: "test", status: "done" },
    ]);
    expect(view.status).toBe("finished");
    expect(view.activeStep).toBeUndefined();
    expect(view.tool).toBeUndefined();
  });

  test("a skipped step is marked skipped and clears the active step", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
      { type: "step:skipped", step: "lint" },
    ]);
    expect(view.steps[0]).toEqual({ name: "lint", status: "skipped" });
    expect(view.activeStep).toBeUndefined();
  });

  test("a failure marks the failing step failed and carries the error", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint", "test"] },
      { type: "step:started", step: "test" },
      { type: "run:failed", step: "test", error: "boom" },
    ]);
    expect(view.steps).toEqual([
      { name: "lint", status: "pending" },
      { name: "test", status: "failed" },
    ]);
    expect(view.status).toBe("failed");
    expect(view.error).toBe("boom");
  });

  test("failure without an explicit step falls back to the active step", () => {
    const view = fold([
      { type: "run:started", pipeline: ["test"] },
      { type: "step:started", step: "test" },
      { type: "run:failed", error: "kaboom" },
    ]);
    expect(view.steps[0]).toEqual({ name: "test", status: "failed" });
  });

  test("cancellation sets status without failing the run", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
      { type: "run:cancelled", step: "lint" },
    ]);
    expect(view.status).toBe("cancelled");
    expect(view.activeStep).toBeUndefined();
    expect(view.error).toBeUndefined();
  });

  test("is pure — it never mutates the input view", () => {
    const before = initialView;
    const after = present(before, { type: "run:started", pipeline: ["lint"] });
    expect(before).toEqual({ steps: [], text: "", logs: [], status: "running" });
    expect(after).not.toBe(before);
  });

  test("step:log appends to the active step's log buffer", () => {
    const view = fold([
      { type: "run:started", pipeline: ["ci-wait"] },
      { type: "step:started", step: "ci-wait" },
      { type: "step:log", step: "ci-wait", message: "ci: build → success" },
      { type: "step:log", step: "ci-wait", message: "ci: test → pending" },
    ]);
    expect(view.logs).toEqual(["ci: build → success", "ci: test → pending"]);
  });

  test("artifact:written sets the step's headline from the first string artifact only", () => {
    const view = fold([
      { type: "run:started", pipeline: ["describe"] },
      { type: "step:started", step: "describe" },
      // describe produces prTitle then prBody; the first string wins, prBody never surfaces.
      { type: "artifact:written", step: "describe", artifact: "prTitle", rendered: "feat: add X" },
      { type: "artifact:written", step: "describe", artifact: "prBody", rendered: "the body" },
    ]);
    expect(view.steps[0]?.rendered).toBe("feat: add X");
  });

  test("artifact:written without a rendered value (a non-string artifact) carries no display state", () => {
    const base = fold([
      { type: "run:started", pipeline: ["open-pr"] },
      { type: "step:started", step: "open-pr" },
    ]);
    const after = present(base, {
      type: "artifact:written",
      step: "open-pr",
      artifact: "pullRequest",
    });
    expect(after).toEqual(base);
  });

  test("ask:pending carries no display state (renderers seal it from the event)", () => {
    const base = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
    ]);
    const after = present(base, { type: "ask:pending", step: "lint", prompt: "ok?" });
    expect(after).toEqual(base);
  });

  test("approval:pending carries no display state (renderers seal it from the event)", () => {
    const base = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
    ]);
    const after = present(base, {
      type: "approval:pending",
      step: "review",
      input: { prompt: "Review findings", findings: [] },
    });
    expect(after).toEqual(base);
  });

  test("pr:opened records the PR URL for the run-end line", () => {
    const view = fold([
      { type: "run:started", pipeline: ["open-pr"] },
      { type: "step:started", step: "open-pr" },
      { type: "pr:opened", url: "https://git-provider.test/pr/7" },
      { type: "step:finished", step: "open-pr" },
      { type: "run:finished" },
    ]);
    expect(view.prUrl).toBe("https://git-provider.test/pr/7");
  });
});
