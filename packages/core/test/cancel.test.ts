import { describe, expect, test } from "bun:test";
import { createEngine } from "../src/engine.ts";
import type { RunEvent } from "../src/events.ts";
import { defineStep } from "../src/step.ts";
import { FakeGitProvider, FakeHarness } from "./fakes.ts";

const types = (events: RunEvent[]) => events.map((e) => e.type);

// A long-running agent Step that never settles on its own — only an Abort ends it.
function neverSettlingAgentStep(name: string) {
  return defineStep({
    name,
    async run(ctx) {
      await ctx.agent.run("long task");
      return {};
    },
  });
}

describe("engine — cancellation", () => {
  test("an external abort mid-Step ends the Run with run:cancelled", async () => {
    const step = neverSettlingAgentStep("agentic");
    const harness = new FakeHarness({ blockUntilAborted: true });
    const controller = new AbortController();
    const engine = createEngine(
      {
        pipeline: [step, neverSettlingAgentStep("after")],
        providers: { gitProvider: new FakeGitProvider(), agent: harness },
      },
      { signal: controller.signal },
    );

    const events: RunEvent[] = [];
    for await (const event of engine.run()) {
      events.push(event);
      if (event.type === "step:started") controller.abort(); // interrupt while running
    }

    expect(events.at(-1)).toEqual({ type: "run:cancelled", step: "agentic" });
    expect(harness.aborted).toBe(true); // the in-flight agent observed its signal
    // The second Step never started.
    expect(events.filter((e) => e.type === "step:started" && e.step === "after")).toHaveLength(0);
    expect(types(events)).not.toContain("run:failed");
  });

  test("abandoning the generator (break) aborts the in-flight agent", async () => {
    const step = neverSettlingAgentStep("agentic");
    const harness = new FakeHarness({ blockUntilAborted: true });
    const engine = createEngine({
      pipeline: [step],
      providers: { gitProvider: new FakeGitProvider(), agent: harness },
    });

    for await (const event of engine.run()) {
      if (event.type === "step:started") break; // breaking calls generator.return()
    }

    // The generator's finally aborts the run signal before the loop returns.
    expect(harness.aborted).toBe(true);
  });
});
