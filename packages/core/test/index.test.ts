import { describe, expect, test } from "bun:test";
import * as core from "../src/index.ts";

const surface = core as Record<string, unknown>;

describe("public surface (@tml/core)", () => {
  test("exposes the authoring helpers, engine, and flow-signal constructors", () => {
    const fns = [
      "defineArtifact",
      "defineStep",
      "createAssembly",
      "createEngine",
      "createGit",
      "until",
      "validatePipeline",
      "skip",
      "cancel",
      "goto",
      "retry",
    ];
    for (const name of fns) {
      expect(typeof surface[name]).toBe("function");
    }
    for (const errorClass of ["AssemblyError", "TimeoutError"]) {
      expect(typeof surface[errorClass]).toBe("function");
    }
  });

  test("does not leak internals", () => {
    expect(surface.isFlowSignal).toBeUndefined();
    expect(surface.PACKAGE).toBeUndefined();
  });
});
