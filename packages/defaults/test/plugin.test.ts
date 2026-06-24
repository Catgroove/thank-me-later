import { describe, expect, test } from "bun:test";
import {
  createAssembly,
  type GitProvider,
  type Harness,
  type Step,
  validatePipeline,
} from "@tml/core";
import { tmlDefaults } from "../src/plugin.ts";

// Run the default Plugin over a real assembly (with stand-in providers seeded, as the host does)
// and read back the assembled pipeline.
function assemble(branch?: string): Step[] {
  const a = createAssembly(branch !== undefined ? { branch } : {}, "/repo");
  a.tml.registerGitProvider("github", () => ({}) as unknown as GitProvider);
  a.tml.registerHarness("pi", () => ({}) as unknown as Harness);
  void tmlDefaults(a.tml);
  return a.build().pipeline;
}

describe("tmlDefaults plugin", () => {
  test("appends the Steps in pipeline order", () => {
    expect(assemble().map((s) => s.name)).toEqual([
      "branch",
      "describe",
      "commit-change",
      "rebase",
      "format",
      "lint",
      "typecheck",
      "test",
      "review",
      "resync",
      "open-pr",
      "ci-wait",
      "merge-gate",
    ]);
  });

  test("the assembled pipeline passes assembly validation (every consumed artifact has a producer)", () => {
    expect(() => validatePipeline(assemble())).not.toThrow();
  });

  test("the branch knob selects the Branch mode; an invalid value is rejected", () => {
    expect(() => assemble("require")).not.toThrow();
    expect(() => assemble("auto")).not.toThrow();
    expect(() => assemble("nonsense")).toThrow(/branch/);
  });
});
