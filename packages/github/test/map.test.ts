import { describe, expect, test } from "bun:test";

import {
  mapCheckNode,
  mapChecks,
  mapCheckStatus,
  mapConclusion,
  mapMergeable,
  mapPullRequest,
  mapReviewThread,
  mapState,
} from "../src/map.ts";
import {
  checkInProgress,
  checkSkipped,
  checkSuccess,
  prConflicted,
  prMerged,
  prOpen,
  statusContextPending,
  statusContextSuccess,
  threadResolved,
  threadUnresolved,
} from "./fixtures.ts";

describe("mapState", () => {
  test("known states", () => {
    expect(mapState("OPEN")).toBe("open");
    expect(mapState("CLOSED")).toBe("closed");
    expect(mapState("MERGED")).toBe("merged");
  });
  test("unknown coarsens to open", () => {
    expect(mapState("WHATEVER")).toBe("open");
  });
});

describe("mapMergeable", () => {
  test("all branches", () => {
    expect(mapMergeable("MERGEABLE")).toBe("mergeable");
    expect(mapMergeable("CONFLICTING")).toBe("conflicted");
    expect(mapMergeable("UNKNOWN")).toBe("unknown");
    expect(mapMergeable("anything-else")).toBe("unknown");
  });
});

describe("mapCheckStatus", () => {
  test("all branches", () => {
    expect(mapCheckStatus("COMPLETED")).toBe("completed");
    expect(mapCheckStatus("IN_PROGRESS")).toBe("in_progress");
    expect(mapCheckStatus("QUEUED")).toBe("queued");
    expect(mapCheckStatus("WAITING")).toBe("queued");
    expect(mapCheckStatus("PENDING")).toBe("queued");
  });
});

describe("mapConclusion", () => {
  test("core union", () => {
    expect(mapConclusion(null)).toBe(null);
    expect(mapConclusion("SUCCESS")).toBe("success");
    expect(mapConclusion("FAILURE")).toBe("failure");
    expect(mapConclusion("CANCELLED")).toBe("cancelled");
    expect(mapConclusion("NEUTRAL")).toBe("neutral");
  });
  test("out-of-union conclusions coarsen to neutral", () => {
    expect(mapConclusion("SKIPPED")).toBe("neutral");
    expect(mapConclusion("TIMED_OUT")).toBe("neutral");
    expect(mapConclusion("ACTION_REQUIRED")).toBe("neutral");
  });
});

describe("mapCheckNode", () => {
  test("CheckRun maps directly", () => {
    expect(mapCheckNode(checkSuccess)).toEqual({
      name: "build",
      status: "completed",
      conclusion: "success",
    });
    expect(mapCheckNode(checkInProgress)).toEqual({
      name: "lint",
      status: "in_progress",
      conclusion: null,
    });
    expect(mapCheckNode(checkSkipped)).toEqual({
      name: "optional",
      status: "completed",
      conclusion: "neutral",
    });
  });
  test("StatusContext synthesizes a CheckRun", () => {
    expect(mapCheckNode(statusContextSuccess)).toEqual({
      name: "ci/legacy",
      status: "completed",
      conclusion: "success",
    });
    expect(mapCheckNode(statusContextPending)).toEqual({
      name: "ci/slow",
      status: "in_progress",
      conclusion: null,
    });
  });
});

describe("mapChecks", () => {
  test("extracts the rollup off the last commit", () => {
    expect(mapChecks(prOpen.commits)).toEqual([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "ci/legacy", status: "completed", conclusion: "success" },
    ]);
  });
  test("no rollup yields an empty list", () => {
    expect(mapChecks(prMerged.commits)).toEqual([]);
  });
});

describe("mapReviewThread", () => {
  test("unresolved thread with a path and multiple comments", () => {
    expect(mapReviewThread(threadUnresolved)).toEqual({
      id: "RT_unresolved",
      path: "src/app.ts",
      body: "nit: rename this",
      resolved: false,
      comments: [
        { author: "reviewer", body: "nit: rename this" },
        { author: "author", body: "done" },
      ],
    });
  });
  test("resolved thread: null path omitted, null author becomes empty string", () => {
    const mapped = mapReviewThread(threadResolved);
    expect(mapped).toEqual({
      id: "RT_resolved",
      body: "general comment",
      resolved: true,
      comments: [{ author: "", body: "general comment" }],
    });
    expect("path" in mapped).toBe(false);
  });
});

describe("mapPullRequest", () => {
  test("open PR with checks and threads", () => {
    expect(mapPullRequest(prOpen)).toEqual({
      number: 42,
      url: "https://github.com/acme/widget/pull/42",
      head: "feat/x",
      base: "main",
      title: "Add x",
      body: "Does x.",
      state: "open",
      mergeable: "mergeable",
      checks: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "ci/legacy", status: "completed", conclusion: "success" },
      ],
      threads: [mapReviewThread(threadUnresolved), mapReviewThread(threadResolved)],
    });
  });
  test("conflicted PR", () => {
    const pr = mapPullRequest(prConflicted);
    expect(pr.mergeable).toBe("conflicted");
    expect(pr.state).toBe("open");
    expect(pr.checks).toEqual([{ name: "test", status: "completed", conclusion: "failure" }]);
    expect(pr.threads).toEqual([]);
  });
  test("merged PR with no rollup", () => {
    const pr = mapPullRequest(prMerged);
    expect(pr.state).toBe("merged");
    expect(pr.mergeable).toBe("unknown");
    expect(pr.checks).toEqual([]);
  });
});
