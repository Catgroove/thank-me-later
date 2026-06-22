// Model selection: the per-Step resolution cascade and its two guards. A model resolves
// most-specific-first — an in-code per-call `{ model }`, else `models[stepName]`, else
// `models.default`, else nothing (the Harness's own default). A `models` key that names no
// Step fails at assembly; a configured id the Harness can't list fails at run start (but only
// when the Harness can list its models at all).

import { describe, expect, test } from "bun:test";
import { createEngine } from "../src/engine.ts";
import type { RunEvent } from "../src/events.ts";
import type { ModelMap, Pipeline } from "../src/pipeline.ts";
import { defineStep } from "../src/step.ts";
import { AssemblyError } from "../src/validate.ts";
import { FakeGitProvider, FakeHarness } from "./fakes.ts";

/** A Step that makes one plain agent call (no in-code model). */
const agentStep = (name: string) =>
  defineStep({
    name,
    run: (ctx) => ctx.agent.run(`do ${name}`).then(() => ({})),
  });

async function runWith(
  pipeline: Pipeline,
  models: ModelMap | undefined,
  harness: FakeHarness,
): Promise<RunEvent[]> {
  const engine = createEngine({
    pipeline,
    providers: { gitProvider: new FakeGitProvider(), agent: harness },
    ...(models !== undefined ? { models } : {}),
  });
  const events: RunEvent[] = [];
  for await (const event of engine.run()) events.push(event);
  return events;
}

describe("model selection — the resolution cascade", () => {
  test("no models configured → no model passed (the harness default)", async () => {
    const harness = new FakeHarness();
    await runWith([agentStep("a"), agentStep("b")], undefined, harness);
    expect(harness.runModels).toEqual([undefined, undefined]);
  });

  test("models.default is the run-wide floor for every agent Step", async () => {
    const harness = new FakeHarness();
    await runWith([agentStep("a"), agentStep("b")], { default: "haiku" }, harness);
    expect(harness.runModels).toEqual(["haiku", "haiku"]);
  });

  test("models[stepName] overrides the default; siblings still fall through to it", async () => {
    const harness = new FakeHarness();
    await runWith(
      [agentStep("branch"), agentStep("review")],
      { default: "haiku", review: "opus" },
      harness,
    );
    // branch → default (haiku); review → its own override (opus).
    expect(harness.runModels).toEqual(["haiku", "opus"]);
  });

  test("per-Step config with no default leaves unkeyed Steps on the harness default", async () => {
    const harness = new FakeHarness();
    await runWith([agentStep("branch"), agentStep("review")], { review: "opus" }, harness);
    expect(harness.runModels).toEqual([undefined, "opus"]);
  });

  test("an in-code per-call { model } wins over both config rungs", async () => {
    const harness = new FakeHarness();
    const pinned = defineStep({
      name: "review",
      run: (ctx) => ctx.agent.run("deep review", { model: "sonnet:high" }).then(() => ({})),
    });
    await runWith([pinned], { default: "haiku", review: "opus" }, harness);
    expect(harness.runModels).toEqual(["sonnet:high"]);
  });
});

describe("model selection — assembly-time validation", () => {
  const cfg = (pipeline: Pipeline, models: ModelMap) => ({
    pipeline,
    providers: { gitProvider: new FakeGitProvider(), agent: new FakeHarness() },
    models,
  });

  test("a models key matching no Step throws AssemblyError before the stream starts", () => {
    expect(() => createEngine(cfg([agentStep("review")], { typo: "opus" }))).toThrow(AssemblyError);
  });

  test("the typo error suggests a near-miss step name", () => {
    expect(() => createEngine(cfg([agentStep("typecheck")], { typcheck: "opus" }))).toThrow(
      /did you mean "typecheck"/,
    );
  });

  test("a Step named `default` is rejected (it collides with the reserved key)", () => {
    expect(() => createEngine(cfg([agentStep("default")], {}))).toThrow(/reserved/);
  });

  test("the reserved `default` key itself is never treated as a missing Step", () => {
    expect(() => createEngine(cfg([agentStep("review")], { default: "haiku" }))).not.toThrow();
  });

  test("models must still have the config shape when config comes from untyped JavaScript", () => {
    expect(() => createEngine(cfg([agentStep("review")], null as unknown as ModelMap))).toThrow(
      /models must be an object/,
    );

    const models = { review: 42 } as unknown as ModelMap;
    expect(() => createEngine(cfg([agentStep("review")], models))).toThrow(/must be a string/);
  });
});

describe("model selection — run-start value validation (gated on listModels)", () => {
  test("a Harness that lists models fails the Run on an unknown configured id", async () => {
    const harness = new FakeHarness({ models: ["haiku", "opus"] });
    const events = await runWith([agentStep("review")], { review: "ghost-model" }, harness);
    const last = events.at(-1);
    expect(last?.type).toBe("run:failed");
    expect(last && "error" in last ? last.error : "").toContain("ghost-model");
    // Failed before any Step ran.
    expect(events.some((e) => e.type === "step:started")).toBe(false);
    expect(harness.runModels).toEqual([]);
  });

  test("all configured ids valid → the Run proceeds normally", async () => {
    const harness = new FakeHarness({ models: ["haiku", "opus"] });
    const events = await runWith(
      [agentStep("review")],
      { default: "haiku", review: "opus" },
      harness,
    );
    expect(events.at(-1)?.type).toBe("run:finished");
    expect(harness.runModels).toEqual(["opus"]);
  });

  test("a Harness without listModels skips the value check entirely", async () => {
    // A minimal Harness lacking the optional `listModels` capability.
    const harness = {
      runModels: [] as (string | undefined)[],
      run(_task: string, opts?: { model?: string }) {
        this.runModels.push(opts?.model);
        return Promise.resolve({ ok: true, summary: "done" });
      },
    };
    const engine = createEngine({
      pipeline: [agentStep("review")],
      providers: { gitProvider: new FakeGitProvider(), agent: harness },
      models: { review: "anything-goes" },
    });
    const events: RunEvent[] = [];
    for await (const event of engine.run()) events.push(event);
    expect(events.at(-1)?.type).toBe("run:finished");
    expect(harness.runModels).toEqual(["anything-goes"]);
  });
});
