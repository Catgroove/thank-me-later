import { describe, expect, test } from "bun:test";

import {
  mapCheckNode,
  mapChecks,
  mapCheckStatus,
  mapConclusion,
  mapLastReviewedSha,
  mapMergeable,
  mapPullRequest,
  mapRestReviewComment,
  mapReviewDecision,
  mapReviewThread,
  mapState,
} from "../src/map.ts";
import {
  checkInProgress,
  checkSkipped,
  checkSuccess,
  lastReviewEmpty,
  lastReviewResponse,
  prConflicted,
  prMerged,
  prOpen,
  statusContextPending,
  statusContextSuccess,
  threadResolved,
  threadThumbsUp,
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

describe("mapReviewDecision", () => {
  test("all branches", () => {
    expect(mapReviewDecision("APPROVED")).toBe("approved");
    expect(mapReviewDecision("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(mapReviewDecision("REVIEW_REQUIRED")).toBe("review_required");
    expect(mapReviewDecision(null)).toBe(null);
    expect(mapReviewDecision("WHATEVER")).toBe(null);
  });
});

describe("mapLastReviewedSha", () => {
  test("returns the newest submitted viewer review, ignoring a trailing PENDING review", () => {
    expect(mapLastReviewedSha(lastReviewResponse.data.repository.pullRequest.reviews.nodes)).toBe(
      "newsha",
    );
  });
  test("null when the viewer has never reviewed", () => {
    expect(mapLastReviewedSha(lastReviewEmpty.data.repository.pullRequest.reviews.nodes)).toBe(
      null,
    );
  });
  test("null when the viewer's only review is still pending", () => {
    expect(
      mapLastReviewedSha([{ viewerDidAuthor: true, state: "PENDING", commit: { oid: "p" } }]),
    ).toBe(null);
  });
});

describe("mapRestReviewComment", () => {
  test("maps a REST review comment into an unresolved single-comment thread", () => {
    expect(
      mapRestReviewComment({
        node_id: "PRRC_1",
        path: "src/a.ts",
        line: 12,
        body: "<!-- tml:finding key=k --> detail",
        user: { login: "tml" },
      }),
    ).toEqual({
      id: "PRRC_1",
      path: "src/a.ts",
      line: 12,
      body: "<!-- tml:finding key=k --> detail",
      resolved: false,
      comments: [
        {
          author: "tml",
          body: "<!-- tml:finding key=k --> detail",
          reactions: { thumbsUp: 0, thumbsDown: 0 },
        },
      ],
    });
  });
  test("omits a null line and maps a null author to empty string", () => {
    const t = mapRestReviewComment({
      node_id: "PRRC_2",
      path: "src/a.ts",
      line: null,
      body: "b",
      user: null,
    });
    expect("line" in t).toBe(false);
    expect(t.comments[0]?.author).toBe("");
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

const noReactions = { thumbsUp: 0, thumbsDown: 0 };

describe("mapReviewThread", () => {
  test("unresolved thread with a path, line, and multiple comments", () => {
    expect(mapReviewThread(threadUnresolved)).toEqual({
      id: "RT_unresolved",
      path: "src/app.ts",
      line: 12,
      body: "nit: rename this",
      resolved: false,
      isOutdated: false,
      comments: [
        { author: "reviewer", body: "nit: rename this", reactions: noReactions },
        { author: "author", body: "done", reactions: noReactions },
      ],
    });
  });
  test("resolved thread: null path/line omitted, null author becomes empty string", () => {
    const mapped = mapReviewThread(threadResolved);
    expect(mapped).toEqual({
      id: "RT_resolved",
      body: "general comment",
      resolved: true,
      isOutdated: false,
      comments: [{ author: "", body: "general comment", reactions: noReactions }],
    });
    expect("path" in mapped).toBe(false);
    expect("line" in mapped).toBe(false);
  });
  test("maps 👍/👎 reaction groups onto the root comment", () => {
    const mapped = mapReviewThread(threadThumbsUp);
    expect(mapped.comments[0]?.reactions).toEqual({ thumbsUp: 1, thumbsDown: 0 });
    expect(mapped.isOutdated).toBe(true);
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
      reviewDecision: "review_required",
      headSha: "headsha000000000000000000000000000000aaa",
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
