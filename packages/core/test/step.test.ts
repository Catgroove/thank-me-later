import { describe, expect, test } from "bun:test";
import { defineArtifact } from "../src/artifact.ts";
import { defineStep } from "../src/step.ts";

describe("defineStep", () => {
  test("populates name, consumes, and produces", () => {
    const input = defineArtifact<string>()("input");
    const output = defineArtifact<number>()("output");
    const step = defineStep({
      name: "derive",
      consumes: [input],
      produces: [output],
      run() {
        return Promise.resolve({ output: 1 });
      },
    });
    expect(step.name).toBe("derive");
    expect(step.consumes).toEqual([input]);
    expect(step.produces).toEqual([output]);
  });

  test("defaults consumes and produces to empty arrays", () => {
    const step = defineStep({
      name: "noop",
      run() {
        return Promise.resolve({});
      },
    });
    expect(step.consumes).toEqual([]);
    expect(step.produces).toEqual([]);
  });
});

// --- Type-level checks. A regression here fails `tsc`, not the test run. ---

const a = defineArtifact<string>()("a");
const b = defineArtifact<number>()("b");
const out = defineArtifact<string>()("out");

// Positive: reading a declared token yields its value type, which feeds `produces`.
defineStep({
  name: "ok",
  consumes: [a],
  produces: [out],
  run(ctx) {
    return Promise.resolve({ out: ctx.read(a) });
  },
});

// Negative: reading a token the Step did not declare in `consumes` is rejected.
defineStep({
  name: "bad",
  consumes: [a],
  run(ctx) {
    // @ts-expect-error — `b` is not in this Step's `consumes`
    ctx.read(b);
    return Promise.resolve({});
  },
});
