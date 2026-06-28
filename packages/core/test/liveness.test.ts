import { describe, expect, test } from "bun:test";
import { classifyLiveness } from "../src/liveness.ts";
import type { RunMetadata } from "../src/run-journal.ts";

const NOW = Date.parse("2026-06-28T12:00:00.000Z");
const HOST = "host-a";

function running(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: "run-1",
    checkoutKey: "key",
    checkoutPath: "/repo",
    pipeline: ["produce"],
    status: "running",
    startedAt: "2026-06-28T11:59:00.000Z",
    updatedAt: "2026-06-28T11:59:30.000Z",
    completedSteps: [],
    owner: { pid: 4821, host: HOST },
    ...overrides,
  };
}

describe("classifyLiveness", () => {
  test("running with a live pid on this host is live", () => {
    const liveness = classifyLiveness(running(), { now: NOW, host: HOST, isAlive: () => true });
    expect(liveness).toBe("live");
  });

  test("running with a dead pid on this host is orphaned", () => {
    const liveness = classifyLiveness(running(), { now: NOW, host: HOST, isAlive: () => false });
    expect(liveness).toBe("orphaned");
  });

  test("running on another host with recent activity is unknown", () => {
    const meta = running({ owner: { pid: 4821, host: "host-b" } });
    const liveness = classifyLiveness(meta, { now: NOW, host: HOST, isAlive: () => true });
    expect(liveness).toBe("unknown");
  });

  test("running on another host that has gone stale is orphaned", () => {
    const meta = running({
      owner: { pid: 4821, host: "host-b" },
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
    const liveness = classifyLiveness(meta, { now: NOW, host: HOST, isAlive: () => true });
    expect(liveness).toBe("orphaned");
  });

  test("legacy running run with no owner falls back to staleness", () => {
    const fresh = running({ owner: undefined, updatedAt: "2026-06-28T11:59:30.000Z" });
    const stale = running({ owner: undefined, updatedAt: "2026-06-28T00:00:00.000Z" });
    expect(classifyLiveness(fresh, { now: NOW, host: HOST })).toBe("unknown");
    expect(classifyLiveness(stale, { now: NOW, host: HOST })).toBe("orphaned");
  });

  test("a terminal status is never live", () => {
    for (const status of ["finished", "failed", "cancelled"] as const) {
      const meta = running({ status });
      expect(classifyLiveness(meta, { now: NOW, host: HOST, isAlive: () => true })).not.toBe(
        "live",
      );
    }
  });
});
