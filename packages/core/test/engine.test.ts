import { describe, expect, test } from "bun:test";
import { defineArtifact } from "../src/artifact.ts";
import { createEngine, type Engine, NotImplementedError } from "../src/engine.ts";
import type { RunEvent } from "../src/events.ts";
import type { Pipeline } from "../src/pipeline.ts";
import { cancel, goto, retry, skip } from "../src/signals.ts";
import { defineStep } from "../src/step.ts";
import { AssemblyError } from "../src/validate.ts";
import { FakeGitProvider, FakeHarness } from "./fakes.ts";

const raw = defineArtifact<string>()("raw");
const derived = defineArtifact<number>()("derived");

function engineFor(pipeline: Pipeline, ask?: (p: string) => Promise<string>): Engine {
  return createEngine(
    { pipeline, providers: { gitProvider: new FakeGitProvider(), agent: new FakeHarness() } },
    ask ? { ask } : {},
  );
}

async function collect(engine: Engine): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of engine.run()) events.push(event);
  return events;
}

const types = (events: RunEvent[]) => events.map((e) => e.type);

describe("engine — happy path", () => {
  test("runs steps in order, threads artifacts, and emits an ordered event stream", async () => {
    const produce = defineStep({
      name: "produce",
      produces: [raw],
      run: () => Promise.resolve({ raw: "hi" }),
    });
    const consume = defineStep({
      name: "consume",
      consumes: [raw],
      produces: [derived],
      run(ctx) {
        const value = ctx.read(raw);
        ctx.log(`raw=${value}`);
        return Promise.resolve({ derived: value.length });
      },
    });

    const events = await collect(engineFor([produce, consume]));

    expect(types(events)).toEqual([
      "run:started",
      "step:started",
      "artifact:written",
      "step:finished",
      "step:started",
      "step:log",
      "artifact:written",
      "step:finished",
      "run:finished",
    ]);
    // The artifact value threaded through the store: consume read "hi".
    expect(events).toContainEqual({ type: "step:log", step: "consume", message: "raw=hi" });
  });

  test("a Step drives a Pending Provider result to resolution via ctx.until", async () => {
    const waitStep = defineStep({
      name: "ci-wait",
      async run(ctx) {
        const checks = await ctx.until(ctx.gitProvider.getChecks(1), { every: 1 });
        ctx.log(`conclusion=${checks[0]?.conclusion}`);
        return {};
      },
    });

    const events = await collect(engineFor([waitStep]));
    expect(events).toContainEqual({
      type: "step:log",
      step: "ci-wait",
      message: "conclusion=success",
    });
    expect(types(events).at(-1)).toBe("run:finished");
  });
});

describe("engine — flow signals, ask, and failure", () => {
  test("skip emits step:skipped and continues", async () => {
    const skipped = defineStep({ name: "skipped", run: () => Promise.resolve(skip()) });
    const events = await collect(engineFor([skipped]));
    expect(types(events)).toEqual(["run:started", "step:started", "step:skipped", "run:finished"]);
  });

  test("cancel ends the Run early but successfully", async () => {
    const stop = defineStep({ name: "stop", run: () => Promise.resolve(cancel("nothing to do")) });
    const never = defineStep({ name: "never", run: () => Promise.resolve({}) });
    const events = await collect(engineFor([stop, never]));
    expect(types(events)).toEqual(["run:started", "step:started", "run:finished"]);
  });

  test("goto jumps forward, skipping the step in between", async () => {
    const a = defineStep({ name: "a", run: () => Promise.resolve(goto("c")) });
    const b = defineStep({ name: "b", run: () => Promise.resolve({}) });
    const c = defineStep({ name: "c", run: () => Promise.resolve({}) });
    const events = await collect(engineFor([a, b, c]));
    expect(types(events)).toEqual([
      "run:started",
      "step:started", // a
      "step:finished", // a (goto)
      "step:started", // c — b was jumped over
      "step:finished",
      "run:finished",
    ]);
    expect(events.filter((e) => e.type === "step:started" && e.step === "b")).toHaveLength(0);
  });

  test("goto to a non-existent Step fails the Run at runtime", async () => {
    const a = defineStep({ name: "a", run: () => Promise.resolve(goto("nowhere")) });
    const events = await collect(engineFor([a]));
    const last = events.at(-1);
    expect(last?.type).toBe("run:failed");
    expect(last && "error" in last ? last.error : "").toContain("nowhere");
  });

  test("retry re-runs the Step and fails once the cap is exceeded", async () => {
    const always = defineStep({ name: "always", run: () => Promise.resolve(retry()) });
    const events = await collect(engineFor([always]));
    // initial attempt + 3 retries = 4 starts, then failure.
    expect(events.filter((e) => e.type === "step:started")).toHaveLength(4);
    expect(types(events).at(-1)).toBe("run:failed");
  });

  test("ctx.ask emits ask:pending and resolves via the injected responder", async () => {
    const asks = defineStep({
      name: "asks",
      async run(ctx) {
        const answer = await ctx.ask("ship it?");
        ctx.log(`answer=${answer}`);
        return {};
      },
    });
    const events = await collect(engineFor([asks], () => Promise.resolve("yes")));
    expect(events).toContainEqual({ type: "ask:pending", step: "asks", prompt: "ship it?" });
    expect(events).toContainEqual({ type: "step:log", step: "asks", message: "answer=yes" });
  });

  test("the default headless ask is NotImplemented", async () => {
    const asks = defineStep({
      name: "asks",
      run: (ctx) => ctx.ask("?").then(() => ({})),
    });
    const events = await collect(engineFor([asks]));
    const last = events.at(-1);
    expect(last?.type).toBe("run:failed");
    expect(last && "error" in last ? last.error : "").toContain("not implemented");
    expect(new NotImplementedError("x")).toBeInstanceOf(Error);
  });

  test("a thrown Step error surfaces as run:failed", async () => {
    const boom = defineStep({
      name: "boom",
      run: () => Promise.reject(new Error("kaboom")),
    });
    const events = await collect(engineFor([boom]));
    expect(events.at(-1)).toEqual({ type: "run:failed", step: "boom", error: "kaboom" });
  });

  test("returning an undeclared artifact key fails the Run", async () => {
    const bad = defineStep({
      name: "bad",
      produces: [raw],
      // Returns a key not in `produces`.
      run: () => Promise.resolve({ raw: "x", bogus: 1 } as unknown as { raw: string }),
    });
    const events = await collect(engineFor([bad]));
    const last = events.at(-1);
    expect(last?.type).toBe("run:failed");
    expect(last && "error" in last ? last.error : "").toContain("bogus");
  });

  test("assembly errors throw from createEngine, before the stream starts", () => {
    const orphan = defineStep({ name: "orphan", consumes: [raw], run: () => Promise.resolve({}) });
    expect(() => engineFor([orphan])).toThrow(AssemblyError);
  });
});

describe("engine — live emission", () => {
  test("agent:progress reaches the consumer before the Step finishes", async () => {
    // The Step blocks on `gate` until the test sees an `agent:progress` event.
    // Under buffer-then-flush the consumer would never see progress (the Step is
    // still running), the gate would never open, and this test would time out —
    // so completing at all proves events are emitted live, mid-Step.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const agentic = defineStep({
      name: "agentic",
      async run(ctx) {
        await ctx.agent.run("do work");
        await gate;
        return {};
      },
    });

    const harness = new FakeHarness({
      progress: [{ kind: "text", text: "thinking…" }],
    });
    const engine = createEngine({
      pipeline: [agentic],
      providers: { gitProvider: new FakeGitProvider(), agent: harness },
    });

    const events: RunEvent[] = [];
    for await (const event of engine.run()) {
      events.push(event);
      if (event.type === "agent:progress") openGate(); // unblock the Step
    }

    const order = types(events);
    const progressAt = order.indexOf("agent:progress");
    const finishedAt = order.indexOf("step:finished");
    expect(progressAt).toBeGreaterThanOrEqual(0);
    expect(progressAt).toBeLessThan(finishedAt);
    expect(events).toContainEqual({
      type: "agent:progress",
      step: "agentic",
      progress: { kind: "text", text: "thinking…" },
    });
    expect(order.at(-1)).toBe("run:finished");
  });
});

describe("engine — pr:opened", () => {
  test("emits pr:opened with the URL when a Step opens a PR", async () => {
    const open = defineStep({
      name: "open-pr",
      async run(ctx) {
        await ctx.gitProvider.openPullRequest({
          head: "feat/x",
          base: "main",
          title: "t",
          body: "b",
        });
        return {};
      },
    });
    const events = await collect(engineFor([open]));
    expect(events).toContainEqual({ type: "pr:opened", url: "https://git-provider.test/pr/1" });
  });

  test("emits pr:opened when a re-run rediscovers an existing PR via findPullRequest", async () => {
    const gitProvider = new FakeGitProvider();
    await gitProvider.openPullRequest({ head: "feat/x", base: "main", title: "t", body: "b" });
    const reuse = defineStep({
      name: "open-pr",
      async run(ctx) {
        await ctx.gitProvider.findPullRequest("feat/x");
        return {};
      },
    });
    const engine = createEngine({
      pipeline: [reuse],
      providers: { gitProvider, agent: new FakeHarness() },
    });
    const events = await collect(engine);
    expect(events).toContainEqual({ type: "pr:opened", url: "https://git-provider.test/pr/1" });
  });

  test("no PR found (findPullRequest → null) emits no pr:opened", async () => {
    const miss = defineStep({
      name: "open-pr",
      async run(ctx) {
        await ctx.gitProvider.findPullRequest("feat/none");
        return {};
      },
    });
    expect(types(await collect(engineFor([miss])))).not.toContain("pr:opened");
  });
});
