import { describe, expect, test } from "bun:test";
import { validatePipeline } from "@tml/core";
import { tmlDefaults } from "../src/plugin.ts";

describe("tmlDefaults plugin", () => {
  test("assembles the eight Steps in pipeline order", () => {
    const plugin = tmlDefaults();
    expect(plugin.name).toBe("@tml/defaults");
    expect(plugin.steps?.map((s) => s.name)).toEqual([
      "branch",
      "format",
      "lint",
      "typecheck",
      "test",
      "review",
      "open-pr",
      "ci-wait",
    ]);
  });

  test("the assembled pipeline passes assembly validation (every consumed artifact has a producer)", () => {
    expect(() => validatePipeline(tmlDefaults().steps ?? [])).not.toThrow();
  });
});
