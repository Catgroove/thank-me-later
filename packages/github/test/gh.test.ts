import { describe, expect, test } from "bun:test";

import { spawnCapture } from "../src/gh.ts";

describe("spawnCapture", () => {
  test("returns stdout on success", async () => {
    expect(await spawnCapture(["echo", "hello"], ".")).toBe("hello\n");
  });

  test("throws with exit code and stderr on failure", async () => {
    let err: unknown;
    try {
      await spawnCapture(["sh", "-c", "echo boom >&2; exit 3"], ".");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exit 3.*boom/s);
  });
});
