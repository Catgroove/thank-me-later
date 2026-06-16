import { describe, expect, test } from "bun:test";
import { defineArtifact } from "../src/artifact.ts";
import type { Config, Pipeline, Providers } from "../src/pipeline.ts";
import { defineStep } from "../src/step.ts";

const raw = defineArtifact<string>()("raw");
const derived = defineArtifact<number>()("derived");

const produce = defineStep({
  name: "produce",
  produces: [raw],
  run() {
    return Promise.resolve({ raw: "x" });
  },
});

const consume = defineStep({
  name: "consume",
  consumes: [raw],
  produces: [derived],
  run(ctx) {
    return Promise.resolve({ derived: ctx.read(raw).length });
  },
});

// Providers aren't exercised here (fakes arrive with the engine); a structural
// stand-in keeps the type check honest without pulling them in early.
const providers = {} as unknown as Providers;

describe("Config / Pipeline types", () => {
  test("a heterogeneous pipeline types as one ordered list and round-trips through a Config", () => {
    const pipeline: Pipeline = [produce, consume];
    const config: Config = { pipeline, providers };
    expect(config.pipeline.map((s) => s.name)).toEqual(["produce", "consume"]);
  });
});
