import { describe, expect, test } from "bun:test";
import { parseShipArgs, shouldGate } from "../src/index.ts";

describe("shouldGate", () => {
  test("bare tml on a TTY consults the gate", () => {
    expect(shouldGate(parseShipArgs([]), true)).toBe(true);
  });

  test("a non-TTY never gates (CI, pipes)", () => {
    expect(shouldGate(parseShipArgs([]), false)).toBe(false);
  });

  test("--plain skips the gate (the plain renderer cannot prompt)", () => {
    expect(shouldGate(parseShipArgs(["--plain"]), true)).toBe(false);
  });

  test("an explicit --fresh or --resume bypasses the gate", () => {
    expect(shouldGate(parseShipArgs(["--fresh"]), true)).toBe(false);
    expect(shouldGate(parseShipArgs(["--resume"]), true)).toBe(false);
    expect(shouldGate(parseShipArgs(["--resume=20260628-abcd1234"]), true)).toBe(false);
  });

  test("a verbose run still gates (it is not an explicit selection)", () => {
    expect(shouldGate(parseShipArgs(["--verbose"]), true)).toBe(true);
  });
});
