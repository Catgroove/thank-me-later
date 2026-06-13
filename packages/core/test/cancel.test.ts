import { describe, expect, test } from "bun:test";
import { createEngine } from "../src/engine.ts";
import type { RunEvent } from "../src/events.ts";
import { defineConfig } from "../src/pipeline.ts";
import { defineStep } from "../src/step.ts";
import { FakeForge, FakeHarness } from "./fakes.ts";

const types = (events: RunEvent[]) => events.map((e) => e.type);

// A long-running agent Step that never settles on its own — only an Abort ends it.
function neverSettlingAgentStep(name: string) {
  return defineStep({
    name,
    async run(ctx) {
      await ctx.until(ctx.agent.run("long task"), { every: 1 });
      return {};
    },
  });
}

describe("engine — cancellation (ADR-0008)", () => {
  test("an external abort mid-Step ends the Run with run:cancelled", async () => {
    const step = neverSettlingAgentStep("agentic");
    const harness = new FakeHarness({ settleAfter: Number.POSITIVE_INFINITY });
    const controller = new AbortController();
    const engine = createEngine(
      defineConfig({
        pipeline: [step, neverSettlingAgentStep("after")],
        providers: { forge: new FakeForge(), agent: harness },
      }),
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
    const harness = new FakeHarness({ settleAfter: Number.POSITIVE_INFINITY });
    const engine = createEngine(
      defineConfig({ pipeline: [step], providers: { forge: new FakeForge(), agent: harness } }),
    );

    for await (const event of engine.run()) {
      if (event.type === "step:started") break; // breaking calls generator.return()
    }

    // The generator's finally aborts the run signal before the loop returns.
    expect(harness.aborted).toBe(true);
  });
});
