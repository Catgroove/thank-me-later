import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import type { RunEvent, RunMetadata } from "@tml/core";
import type { Renderer, ViewState } from "@tml/view";
import {
  displayState,
  formatRunsTable,
  humanizeAge,
  resolveRun,
  runs,
  runLabel,
  shortRunId,
  viewRun,
} from "../src/runs.ts";

const NOW = Date.parse("2026-06-28T12:00:00.000Z");

function run(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: "20260628110000-a1b2c3d4",
    checkoutKey: "key",
    checkoutPath: "/repo",
    pipeline: ["produce"],
    status: "finished",
    startedAt: "2026-06-28T11:00:00.000Z",
    updatedAt: "2026-06-28T11:00:00.000Z",
    completedSteps: [],
    ...overrides,
  };
}

describe("runs command", () => {
  test("prints a friendly note when there are no runs", async () => {
    const lines: string[] = [];
    const code = await runs({ cwd: "/repo", list: async () => [], out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/No runs recorded/);
  });

  test("renders a header and one row per run", async () => {
    const lines: string[] = [];
    const code = await runs({
      cwd: "/repo",
      now: NOW,
      list: async () => [
        run({ runId: "20260628113000-cafebabe", resumeKey: "feature-a", status: "cancelled" }),
        run({
          runId: "20260628100000-deadbeef",
          workspaceBranch: "feature-b",
          status: "finished",
          prUrl: "https://example/pull/7",
        }),
      ],
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines[0]).toContain("STATE");
    expect(lines[0]).toContain("BRANCH");
    expect(lines[0]).toContain("PR");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("cancelled");
    expect(lines[1]).toContain("feature-a");
    expect(lines[1]).toContain("cafebabe");
    expect(lines[2]).toContain("https://example/pull/7");
  });
});

function recordingRenderer(): Renderer & { views: ViewState[]; closed: boolean } {
  const self = {
    views: [] as ViewState[],
    closed: false,
    render(view: ViewState) {
      self.views.push(view);
    },
    complete() {},
    close() {
      self.closed = true;
    },
  };
  return self;
}

describe("resolveRun", () => {
  const all = [
    run({ runId: "20260628113000-cafebabe" }),
    run({ runId: "20260628100000-deadbeef" }),
    run({ runId: "20260628090000-deadc0de" }),
  ];

  test("matches an exact id, a short suffix, and a unique prefix", () => {
    expect((resolveRun(all, "20260628113000-cafebabe") as RunMetadata).runId).toContain("cafebabe");
    expect((resolveRun(all, "cafebabe") as RunMetadata).runId).toContain("cafebabe");
    expect((resolveRun(all, "20260628113000") as RunMetadata).runId).toContain("cafebabe");
  });

  test("returns the candidate array when ambiguous and undefined when unmatched", () => {
    expect(resolveRun(all, "deadx")).toBeUndefined();
    expect(resolveRun(all, "missing")).toBeUndefined();
    const ambiguous = resolveRun(all, "20260628");
    expect(Array.isArray(ambiguous)).toBe(true);
  });
});

describe("viewRun", () => {
  const events: RunEvent[] = [
    { type: "run:started", at: 0, pipeline: ["produce"] },
    { type: "run:finished", at: 1 },
  ];

  test("replays a finished run and closes the renderer", async () => {
    const renderer = recordingRenderer();
    const code = await viewRun({
      cwd: "/repo",
      runId: "cafebabe",
      renderer,
      list: async () => [run({ runId: "20260628113000-cafebabe", status: "finished" })],
      readEvents: async () => events,
    });
    expect(code).toBe(0);
    expect(renderer.views.at(-1)?.status).toBe("finished");
    expect(renderer.closed).toBe(true);
  });

  test("reports an unknown id without touching the renderer", async () => {
    const lines: string[] = [];
    const code = await viewRun({
      cwd: "/repo",
      runId: "nope",
      list: async () => [run({ runId: "20260628113000-cafebabe" })],
      out: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/no run matches/);
  });

  test("reports an ambiguous id", async () => {
    const lines: string[] = [];
    const code = await viewRun({
      cwd: "/repo",
      runId: "2026",
      list: async () => [run({ runId: "2026-aaaa" }), run({ runId: "2026-bbbb" })],
      out: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/matches 2 runs/);
  });
});

describe("formatRunsTable helpers", () => {
  test("displayState reports liveness for running runs", () => {
    const fresh = run({
      status: "running",
      owner: { pid: process.pid, host: hostname() },
      updatedAt: "2026-06-28T11:59:59.000Z",
    });
    expect(displayState(fresh, NOW)).toBe("running");

    const orphan = run({
      status: "running",
      owner: { pid: 999_999, host: hostname() },
    });
    expect(displayState(orphan, NOW)).toBe("orphaned");

    expect(displayState(run({ status: "failed" }), NOW)).toBe("failed");
  });

  test("runLabel prefers the workspace branch, then the resume key", () => {
    expect(runLabel(run({ workspaceBranch: "ws", resumeKey: "rk" }))).toBe("ws");
    expect(runLabel(run({ resumeKey: "rk" }))).toBe("rk");
    expect(runLabel(run())).toBe("-");
  });

  test("shortRunId is the suffix after the timestamp", () => {
    expect(shortRunId("20260628110000-a1b2c3d4")).toBe("a1b2c3d4");
    expect(shortRunId("plainid")).toBe("plainid");
  });

  test("humanizeAge is coarse", () => {
    expect(humanizeAge(5_000)).toBe("5s");
    expect(humanizeAge(3 * 60_000)).toBe("3m");
    expect(humanizeAge(2 * 3_600_000)).toBe("2h");
    expect(humanizeAge(4 * 86_400_000)).toBe("4d");
  });

  test("columns are aligned to a shared width", () => {
    const lines = formatRunsTable(
      [
        run({ status: "finished", resumeKey: "short" }),
        run({ status: "cancelled", resumeKey: "a-much-longer-branch-name" }),
      ],
      NOW,
    );
    const branchStart = lines[0]?.indexOf("BRANCH") ?? -1;
    // Every row's ID column begins at the same offset because BRANCH is padded to its max width.
    const idStarts = lines.slice(1).map((line) => line.indexOf("2026", branchStart));
    expect(new Set(idStarts).size).toBe(1);
  });
});
