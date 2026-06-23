import { describe, expect, test } from "bun:test";
import { makeFinding, type RoundRecord, type RunEvent, type RunEventInput } from "@tml/core";
import { initialView, present, type StepView, type ViewState } from "../src/present.ts";

/** Stamp a deterministic `at` (the event index) unless the fixture sets one explicitly. */
const stamp = (event: RunEventInput, i: number): RunEvent => ({ at: i, ...event }) as RunEvent;

/** Fold a whole sequence, as `ship()` does, stamping each event with its index as `at`. */
const fold = (events: RunEventInput[]): ViewState =>
  events.reduce<ViewState>((view, event, i) => present(view, stamp(event, i)), initialView);

const step = (view: ViewState, name: string): StepView => {
  const found = view.steps.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no step ${name}`);
  return found;
};

const finding = makeFinding("review", {
  severity: "warning",
  action: "ask-user",
  title: "Confirm",
  detail: "Needs a decision.",
});

describe("present", () => {
  test("run:started seeds steps in pipeline order, all pending with empty fact buffers", () => {
    const view = fold([{ type: "run:started", pipeline: ["branch", "lint", "test"] }]);
    expect(view.steps.map((s) => [s.name, s.status])).toEqual([
      ["branch", "pending"],
      ["lint", "pending"],
      ["test", "pending"],
    ]);
    expect(view.steps[0]).toMatchObject({ artifacts: [], rounds: [], findings: [], activity: [] });
    expect(view.status).toBe("running");
    expect(view.startedAt).toBe(0);
    expect(view.activeStep).toBeUndefined();
  });

  test("step:started activates the step, stamps startedAt, resets the active-step buffers", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "agent:progress", step: "lint", progress: { kind: "text", text: "stale" } },
      { type: "step:log", step: "lint", message: "stale log" },
      { type: "step:started", step: "lint" },
    ]);
    expect(view.activeStep).toBe("lint");
    expect(step(view, "lint").status).toBe("active");
    expect(step(view, "lint").startedAt).toBe(3);
    expect(view.text).toBe("");
    expect(view.tool).toBeUndefined();
    expect(view.logs).toEqual([]);
  });

  test("agent:progress text deltas coalesce into the active step's buffer and activity", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
      { type: "agent:progress", step: "lint", progress: { kind: "text", text: "Ran " } },
      { type: "agent:progress", step: "lint", progress: { kind: "text", text: "the checks" } },
    ]);
    expect(view.text).toBe("Ran the checks");
    // Consecutive text entries coalesce into one activity entry, not one per delta.
    expect(step(view, "lint").activity).toEqual([
      { at: 3, step: "lint", kind: "text", text: "Ran the checks" },
    ]);
  });

  test("a tool start sets the tool (top-level + per-step); a tool end clears it", () => {
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
    expect(step(afterStart, "format").currentTool).toEqual({ name: "bash", detail: "bun run fmt" });

    const afterEnd = present(afterStart, {
      type: "agent:progress",
      at: 99,
      step: "format",
      progress: { kind: "tool", name: "bash", phase: "end" },
    });
    expect(afterEnd.tool).toBeUndefined();
    expect(step(afterEnd, "format").currentTool).toBeUndefined();
    // The tool call is retained in the activity trail with both phases.
    expect(step(afterEnd, "format").activity.map((e) => e.phase)).toEqual(["start", "end"]);
  });

  test("step:finished marks done and derives duration from event timestamps", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint", "test"] },
      { type: "step:started", step: "lint" }, // at 1
      { type: "step:finished", step: "lint" }, // at 2
      { type: "step:started", step: "test" },
      { type: "step:finished", step: "test" },
      { type: "run:finished" },
    ]);
    expect(view.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(step(view, "lint")).toMatchObject({ startedAt: 1, finishedAt: 2, durationMs: 1 });
    expect(view.status).toBe("finished");
    expect(view.activeStep).toBeUndefined();
  });

  test("a skipped step is marked skipped and clears the active step", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
      { type: "step:skipped", step: "lint" },
    ]);
    expect(step(view, "lint").status).toBe("skipped");
    expect(view.activeStep).toBeUndefined();
  });

  test("a failure marks the failing step failed and carries the error", () => {
    const view = fold([
      { type: "run:started", pipeline: ["lint", "test"] },
      { type: "step:started", step: "test" },
      { type: "run:failed", step: "test", error: "boom" },
    ]);
    expect(step(view, "lint").status).toBe("pending");
    expect(step(view, "test").status).toBe("failed");
    expect(step(view, "test").error).toBe("boom");
    expect(view.status).toBe("failed");
    expect(view.error).toBe("boom");
  });

  test("failure without an explicit step falls back to the active step", () => {
    const view = fold([
      { type: "run:started", pipeline: ["test"] },
      { type: "step:started", step: "test" },
      { type: "run:failed", error: "kaboom" },
    ]);
    expect(step(view, "test").status).toBe("failed");
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
    const after = present(before, { type: "run:started", at: 0, pipeline: ["lint"] });
    expect(before).toEqual(initialView);
    expect(after).not.toBe(before);
  });

  test("step:log appends to the active step's buffer and the activity trail", () => {
    const view = fold([
      { type: "run:started", pipeline: ["ci-wait"] },
      { type: "step:started", step: "ci-wait" },
      { type: "step:log", step: "ci-wait", message: "ci: build → success" },
      { type: "step:log", step: "ci-wait", message: "ci: test → pending" },
    ]);
    expect(view.logs).toEqual(["ci: build → success", "ci: test → pending"]);
    expect(step(view, "ci-wait").activity.filter((e) => e.kind === "log")).toHaveLength(2);
  });

  test("artifact:written records every artifact and takes the first string as the headline", () => {
    const view = fold([
      { type: "run:started", pipeline: ["describe"] },
      { type: "step:started", step: "describe" },
      // describe produces prTitle then prBody; the first string wins as headline, both are recorded.
      { type: "artifact:written", step: "describe", artifact: "prTitle", rendered: "feat: add X" },
      { type: "artifact:written", step: "describe", artifact: "prBody", rendered: "the body" },
    ]);
    expect(step(view, "describe").headline).toBe("feat: add X");
    expect(step(view, "describe").artifacts.map((a) => a.name)).toEqual(["prTitle", "prBody"]);
    expect(step(view, "describe").artifacts[1]).toMatchObject({
      name: "prBody",
      rendered: "the body",
    });
  });

  test("a non-string artifact is recorded without a rendered value and is not the headline", () => {
    const view = fold([
      { type: "run:started", pipeline: ["open-pr"] },
      { type: "step:started", step: "open-pr" },
      { type: "artifact:written", step: "open-pr", artifact: "pullRequest" },
    ]);
    expect(step(view, "open-pr").headline).toBeUndefined();
    expect(step(view, "open-pr").artifacts).toEqual([{ name: "pullRequest", at: 2 }]);
  });

  test("round:recorded appends rounds and updates current findings (latest round wins)", () => {
    const cleared: RoundRecord = { step: "review", index: 1, trigger: "verify", findings: [] };
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      {
        type: "round:recorded",
        step: "review",
        round: { step: "review", index: 0, trigger: "initial", findings: [finding] },
      },
      { type: "round:recorded", step: "review", round: cleared },
    ]);
    expect(step(view, "review").rounds).toHaveLength(2);
    // The latest round (index 1) cleared the findings.
    expect(step(view, "review").findings).toEqual([]);
  });

  test("round findings surface before any approval gate", () => {
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      {
        type: "round:recorded",
        step: "review",
        round: { step: "review", index: 0, trigger: "initial", findings: [finding] },
      },
    ]);
    expect(step(view, "review").findings).toEqual([finding]);
  });

  test("phase:started appends an active phase; phase:finished resolves it with its findings", () => {
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      { type: "phase:started", step: "review", phase: "Context & intent", group: "initial" },
      {
        type: "phase:finished",
        step: "review",
        phase: "Context & intent",
        group: "initial",
        findings: [finding],
        status: "ok",
      },
    ]);
    expect(step(view, "review").phases).toHaveLength(1);
    expect(step(view, "review").phases[0]).toMatchObject({
      label: "Context & intent",
      group: "initial",
      status: "done",
      findings: [finding],
    });
  });

  test("phase findings surface live before any round is recorded", () => {
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      { type: "phase:started", step: "review", phase: "Architecture & scope", group: "initial" },
      {
        type: "phase:finished",
        step: "review",
        phase: "Architecture & scope",
        group: "initial",
        findings: [finding],
        status: "ok",
      },
    ]);
    // The round set is still empty (no round recorded), but the phase carries the finding.
    expect(step(view, "review").findings).toEqual([]);
    expect(step(view, "review").phases[0]?.findings).toEqual([finding]);
  });

  test("phase:finished with status error marks the phase failed", () => {
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      { type: "phase:started", step: "review", phase: "Structural", group: "initial" },
      {
        type: "phase:finished",
        step: "review",
        phase: "Structural",
        group: "initial",
        findings: [],
        status: "error",
      },
    ]);
    expect(step(view, "review").phases[0]).toMatchObject({ status: "failed" });
  });

  test("a re-run phase (same label + group) resolves the latest still-active occurrence", () => {
    const started: RunEventInput = {
      type: "phase:started",
      step: "review",
      phase: "Architecture & scope",
      group: "initial",
    };
    const finished: RunEventInput = {
      type: "phase:finished",
      step: "review",
      phase: "Architecture & scope",
      group: "initial",
      findings: [],
      status: "ok",
    };
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      started,
      finished,
      started, // tainted-worktree rerun: a second occurrence
      finished,
    ]);
    const phases = step(view, "review").phases;
    expect(phases).toHaveLength(2);
    expect(phases.every((p) => p.status === "done")).toBe(true);
  });

  test("ask:pending sets a pending interaction; the next event clears it", () => {
    const base = fold([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
    ]);
    const asking = present(base, { type: "ask:pending", at: 5, step: "lint", prompt: "ok?" });
    expect(asking.pendingInteraction).toEqual({ kind: "ask", step: "lint", prompt: "ok?", at: 5 });
    // The Run is blocked while pending; the resolving event (more Step work) clears it.
    const resolved = present(asking, {
      type: "step:log",
      at: 6,
      step: "lint",
      message: "answer=yes",
    });
    expect(resolved.pendingInteraction).toBeUndefined();
  });

  test("approval:pending sets a structured pending interaction", () => {
    const input = { prompt: "Review findings", findings: [finding] };
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      { type: "approval:pending", step: "review", input },
    ]);
    expect(view.pendingInteraction).toMatchObject({ kind: "approval", step: "review", input });
  });

  test("terminal events clear a pending interaction", () => {
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      { type: "approval:pending", step: "review", input: { prompt: "p", findings: [] } },
      { type: "run:finished" },
    ]);
    expect(view.pendingInteraction).toBeUndefined();
  });

  test("pr:opened records the PR URL", () => {
    const view = fold([
      { type: "run:started", pipeline: ["open-pr"] },
      { type: "step:started", step: "open-pr" },
      { type: "pr:opened", url: "https://git-provider.test/pr/7" },
      { type: "step:finished", step: "open-pr" },
      { type: "run:finished" },
    ]);
    expect(view.prUrl).toBe("https://git-provider.test/pr/7");
  });

  test("activity buffers are bounded under high-volume streams", () => {
    const events: RunEventInput[] = [
      { type: "run:started", pipeline: ["work"] },
      { type: "step:started", step: "work" },
    ];
    // Interleave tool calls so consecutive text entries do not all coalesce into one.
    for (let i = 0; i < 1000; i += 1) {
      events.push({
        type: "agent:progress",
        step: "work",
        progress: { kind: "tool", name: "bash", phase: "start", detail: `cmd ${i}` },
      });
    }
    const view = fold(events);
    // The per-step trail is capped (200) and the global trail is capped (500); neither grows to 1000.
    expect(step(view, "work").activity.length).toBeLessThanOrEqual(200);
    expect(view.globalActivity.length).toBeLessThanOrEqual(500);
    // The most recent entries are retained.
    expect(step(view, "work").activity.at(-1)?.tool?.detail).toBe("cmd 999");
  });

  test("a coalesced text activity entry keeps only its bounded tail", () => {
    const big = "x".repeat(10_000);
    const view = fold([
      { type: "run:started", pipeline: ["work"] },
      { type: "step:started", step: "work" },
      { type: "agent:progress", step: "work", progress: { kind: "text", text: big } },
    ]);
    const entry = step(view, "work").activity.at(-1);
    expect(entry?.kind).toBe("text");
    expect((entry?.text?.length ?? 0) <= 4000).toBe(true);
  });

  test("unknown plugin-like step names are folded with no default-specific behavior", () => {
    const view = fold([
      { type: "run:started", pipeline: ["totally-custom-step"] },
      { type: "step:started", step: "totally-custom-step" },
      { type: "artifact:written", step: "totally-custom-step", artifact: "x", rendered: "hi" },
      { type: "step:finished", step: "totally-custom-step" },
    ]);
    expect(step(view, "totally-custom-step")).toMatchObject({ status: "done", headline: "hi" });
  });
});
