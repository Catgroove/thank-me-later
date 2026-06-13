import { describe, expect, test } from "bun:test";
import { createPiHarness } from "../src/harness.ts";

// Opt-in smoke against a real `pi`. Skipped by default so the suite stays
// network-/creds-free; set TML_PI_LIVE=1 (with pi installed + provider creds) to
// catch JSONL/argv drift the hermetic fixtures can't.
const LIVE = process.env.TML_PI_LIVE === "1";

describe("createPiHarness — live smoke (opt-in)", () => {
  if (!LIVE) {
    console.log(
      "[pi live.test] skipped — set TML_PI_LIVE=1 (pi installed + provider creds) to exercise " +
        "real `pi --mode json`: a one-shot run (stream → summary) and listModels, catching JSONL/argv drift.",
    );
    test.skip("set TML_PI_LIVE=1 to run a real pi task end-to-end", () => {});
    return;
  }

  test("runs a trivial task end-to-end and resolves an ok result", async () => {
    const harness = createPiHarness(process.cwd());
    const result = await harness.run("Reply with exactly one word: pong");
    expect(result.ok).toBe(true);
    expect(result.summary.toLowerCase()).toContain("pong");
  }, 60_000);

  test("listModels returns a non-empty list", async () => {
    const harness = createPiHarness(process.cwd());
    const models = await harness.listModels?.();
    expect(Array.isArray(models)).toBe(true);
    expect((models ?? []).length).toBeGreaterThan(0);
  }, 30_000);
});
