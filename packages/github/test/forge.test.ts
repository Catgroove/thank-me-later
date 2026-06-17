import { describe, expect, test } from "bun:test";

import type { Forge } from "@tml/core";

import { createGitHubForge, type GitHubForgeOptions } from "../src/forge.ts";
import type { GhRunner } from "../src/gh.ts";
import { createGitHubForge as fromIndex } from "../src/index.ts";
import * as pkg from "../src/index.ts";
import {
  addThreadResponse,
  checksAllDone,
  checksEmpty,
  checksPending,
  checksWithFailure,
  lastReviewEmpty,
  lastReviewResponse,
  prConflicted,
  prCreateOutput,
  prIdResponse,
  prListEmpty,
  prListHit,
  snapshotConflictedResponse,
  snapshotOpenResponse,
} from "./fixtures.ts";

/** A fake runner that records calls and routes by argv to canned JSON. */
function fakeRunner(handler: (args: string[]) => string): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    return Promise.resolve(handler(args));
  };
  return { run, calls };
}

const isPrList = (args: string[]) => args[0] === "pr" && args[1] === "list";
const isPrCreate = (args: string[]) => args[0] === "pr" && args[1] === "create";
const isPrEdit = (args: string[]) => args[0] === "pr" && args[1] === "edit";
const isSnapshot = (args: string[]) => args.some((a) => a.includes("reviewThreads"));
const has = (args: string[], needle: string) => args.some((a) => a.includes(needle));
const isPrIdQuery = (args: string[]) => has(args, "pullRequest(number: $number) { id }");
const isAddThread = (args: string[]) => has(args, "addPullRequestReviewThread(input");
const isAddReply = (args: string[]) => has(args, "addPullRequestReviewThreadReply");
const isResolve = (args: string[]) => has(args, "resolveReviewThread");
const isAddReview = (args: string[]) => has(args, "addPullRequestReview(input");
const isLastReview = (args: string[]) => has(args, "reviews(last:");

function forgeWith(handler: (args: string[]) => string): {
  forge: ReturnType<typeof createGitHubForge>;
  calls: string[][];
} {
  const { run, calls } = fakeRunner(handler);
  const opts: GitHubForgeOptions = { run };
  return { forge: createGitHubForge("/repo", opts), calls };
}

describe("findPullRequest", () => {
  test("returns the full snapshot for an existing head branch", async () => {
    const { forge, calls } = forgeWith((args) => {
      if (isPrList(args)) return JSON.stringify(prListHit);
      if (isSnapshot(args)) return JSON.stringify(snapshotOpenResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const pr = await forge.findPullRequest("feat/x");
    expect(pr?.number).toBe(42);
    expect(pr?.mergeable).toBe("mergeable");
    expect(calls[0]).toEqual([
      "pr",
      "list",
      "--head",
      "feat/x",
      "--state",
      "all",
      "--json",
      "number,state",
    ]);
  });

  test("prefers an open PR when older spent PRs use the same head branch", async () => {
    const { forge, calls } = forgeWith((args) => {
      if (isPrList(args)) {
        return JSON.stringify([
          { number: 41, state: "MERGED" },
          { number: 42, state: "OPEN" },
        ]);
      }
      if (isSnapshot(args) && args.includes("number=42"))
        return JSON.stringify(snapshotOpenResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const pr = await forge.findPullRequest("feat/x");

    expect(pr?.number).toBe(42);
    expect(calls).toHaveLength(2);
  });

  test("returns null when no PR exists for the head", async () => {
    const { forge } = forgeWith((args) => {
      if (isPrList(args)) return JSON.stringify(prListEmpty);
      throw new Error("should not snapshot when the list is empty");
    });
    expect(await forge.findPullRequest("feat/none")).toBe(null);
  });
});

describe("openPullRequest", () => {
  test("creates the PR then returns its snapshot", async () => {
    const { forge, calls } = forgeWith((args) => {
      if (isPrCreate(args)) return prCreateOutput;
      if (isSnapshot(args)) return JSON.stringify(snapshotOpenResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const input = { head: "feat/x", base: "main", title: "Add x", body: "Does x." };
    const pr = await forge.openPullRequest(input);
    expect(pr.number).toBe(42);
    expect(calls[0]).toEqual([
      "pr",
      "create",
      "--head",
      "feat/x",
      "--base",
      "main",
      "--title",
      "Add x",
      "--body",
      "Does x.",
    ]);
  });
});

describe("getPullRequest", () => {
  test("maps the snapshot for a given number", async () => {
    const { forge } = forgeWith((args) => {
      if (isSnapshot(args)) return JSON.stringify(snapshotConflictedResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    const pr = await forge.getPullRequest(prConflicted.number);
    expect(pr.mergeable).toBe("conflicted");
    expect(pr.checks).toEqual([{ name: "test", status: "completed", conclusion: "failure" }]);
  });
});

describe("public surface", () => {
  test("exports only createGitHubForge at runtime (GhRunner is type-only)", () => {
    expect(Object.keys(pkg)).toEqual(["createGitHubForge"]);
  });

  test("the index re-export is a Forge", () => {
    const forge: Forge = fromIndex("/repo", { run: () => Promise.resolve("[]") });
    expect(typeof forge.findPullRequest).toBe("function");
    expect(typeof forge.openPullRequest).toBe("function");
    expect(typeof forge.getPullRequest).toBe("function");
    expect(typeof forge.getChecks).toBe("function");
  });
});

describe("getChecks polling", () => {
  /** A runner that walks `responses`, repeating the last once exhausted. */
  function advancingRunner(responses: string[]): GhRunner {
    let i = 0;
    return () => {
      const r = responses[Math.min(i, responses.length - 1)] ?? "";
      i += 1;
      return Promise.resolve(r);
    };
  }

  test("reports not-done while a run is in progress, then done once all complete", async () => {
    const run = advancingRunner([JSON.stringify(checksPending), JSON.stringify(checksAllDone)]);
    const pending = createGitHubForge("/repo", { run }).getChecks(42);

    expect(await pending.poll()).toEqual({ done: false });
    expect(await pending.poll()).toEqual({
      done: true,
      value: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "ci/legacy", status: "completed", conclusion: "success" },
      ],
    });
  });

  test("an empty checks set settles immediately", async () => {
    const run: GhRunner = () => Promise.resolve(JSON.stringify(checksEmpty));
    const result = await createGitHubForge("/repo", { run }).getChecks(42).poll();
    expect(result).toEqual({ done: true, value: [] });
  });

  test("settles even when a completed check failed — the step decides pass/fail", async () => {
    const run: GhRunner = () => Promise.resolve(JSON.stringify(checksWithFailure));
    const result = await createGitHubForge("/repo", { run }).getChecks(42).poll();
    expect(result.done).toBe(true);
  });
});

describe("updatePullRequestBody", () => {
  test("edits the PR body via gh pr edit", async () => {
    const { forge, calls } = forgeWith((args) => {
      if (isPrEdit(args)) return "";
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    await forge.updatePullRequestBody({ prNumber: 42, body: "new body" });
    expect(calls[0]).toEqual(["pr", "edit", "42", "--body", "new body"]);
  });
});

describe("createReviewThread", () => {
  test("looks up the PR node id, posts the thread, and maps it back", async () => {
    const { forge, calls } = forgeWith((args) => {
      if (isPrIdQuery(args)) return JSON.stringify(prIdResponse);
      if (isAddThread(args)) return JSON.stringify(addThreadResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const thread = await forge.createReviewThread({
      prNumber: 42,
      path: "src/x.ts",
      line: 9,
      body: "<!-- tml:finding key=k1 --> detail",
      commitSha: "deadbeef",
    });

    expect(thread.id).toBe("RT_new");
    expect(thread.line).toBe(9);
    const mutation = calls.find(isAddThread);
    expect(mutation).toContain("prId=PR_node_42");
    expect(mutation).toContain("line=9");
    expect(mutation).toContain("-F"); // line is sent as a numeric variable
  });
});

describe("replyToThread / resolveThread", () => {
  test("replyToThread sends the thread id and body", async () => {
    const { forge, calls } = forgeWith((args) => {
      if (isAddReply(args)) return "{}";
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    await forge.replyToThread({ threadId: "RT_1", body: "fixed in abc123" });
    const call = calls.find(isAddReply);
    expect(call).toContain("threadId=RT_1");
    expect(call).toContain("body=fixed in abc123");
  });

  test("resolveThread sends the thread id", async () => {
    const { forge, calls } = forgeWith((args) => {
      if (isResolve(args)) return "{}";
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    await forge.resolveThread("RT_2");
    expect(calls.find(isResolve)).toContain("threadId=RT_2");
  });
});

describe("submitReview", () => {
  test("looks up the PR node id and submits a COMMENT review tied to the commit", async () => {
    const { forge, calls } = forgeWith((args) => {
      if (isPrIdQuery(args)) return JSON.stringify(prIdResponse);
      if (isAddReview(args)) return "{}";
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    await forge.submitReview({ prNumber: 42, commitSha: "headsha", body: "Reviewed." });
    const call = calls.find(isAddReview);
    expect(call).toContain("prId=PR_node_42");
    expect(call).toContain("commit=headsha");
  });
});

describe("lastReviewedSha", () => {
  test("returns the newest viewer-authored review commit", async () => {
    const { forge } = forgeWith((args) => {
      if (isLastReview(args)) return JSON.stringify(lastReviewResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    expect(await forge.lastReviewedSha(42)).toBe("newsha");
  });

  test("null when there is no viewer review", async () => {
    const { forge } = forgeWith((args) => {
      if (isLastReview(args)) return JSON.stringify(lastReviewEmpty);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    expect(await forge.lastReviewedSha(42)).toBe(null);
  });
});

describe("error propagation", () => {
  test("a runner failure surfaces from each method", async () => {
    const run: GhRunner = () => Promise.reject(new Error("gh boom"));
    const forge = createGitHubForge("/repo", { run });

    for (const call of [
      () => forge.findPullRequest("x"),
      () => forge.getPullRequest(1),
      () => forge.openPullRequest({ head: "x", base: "main", title: "t", body: "b" }),
      () => forge.getChecks(1).poll(),
    ]) {
      let err: unknown;
      try {
        await call();
      } catch (e) {
        err = e;
      }
      expect((err as Error | undefined)?.message).toBe("gh boom");
    }
  });
});
