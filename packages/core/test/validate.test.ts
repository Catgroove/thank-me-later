import { describe, expect, test } from "bun:test";
import { defineArtifact } from "../src/artifact.ts";
import type { Pipeline } from "../src/pipeline.ts";
import { defineStep } from "../src/step.ts";
import { AssemblyError, validatePipeline } from "../src/validate.ts";

const raw = defineArtifact<string>()("raw");
const derived = defineArtifact<number>()("derived");

const produceRaw = defineStep({
  name: "produce",
  produces: [raw],
  run: () => Promise.resolve({ raw: "x" }),
});

const consumeRaw = defineStep({
  name: "consume",
  consumes: [raw],
  produces: [derived],
  run: (ctx) => Promise.resolve({ derived: ctx.read(raw).length }),
});

describe("validatePipeline", () => {
  test("accepts a pipeline where every consumed artifact has an earlier producer", () => {
    expect(() => validatePipeline([produceRaw, consumeRaw])).not.toThrow();
  });

  test("rejects consuming an artifact with no producer", () => {
    expect(() => validatePipeline([consumeRaw])).toThrow(AssemblyError);
  });

  test("rejects a consumer placed before its producer (order matters)", () => {
    expect(() => validatePipeline([consumeRaw, produceRaw])).toThrow(AssemblyError);
  });

  test("rejects two Steps producing the same artifact", () => {
    const alsoProducesRaw = defineStep({
      name: "produce-2",
      produces: [raw],
      run: () => Promise.resolve({ raw: "y" }),
    });
    expect(() => validatePipeline([produceRaw, alsoProducesRaw])).toThrow(AssemblyError);
  });

  test("rejects duplicate Step names", () => {
    const dupe = defineStep({ name: "produce", run: () => Promise.resolve({}) });
    const pipeline: Pipeline = [produceRaw, dupe];
    expect(() => validatePipeline(pipeline)).toThrow(AssemblyError);
  });
});
