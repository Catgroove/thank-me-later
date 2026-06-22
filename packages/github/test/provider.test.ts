import { describe, expect, test } from "bun:test";

import type { GitProvider } from "@tml/core";

import { createGitHubProvider, type GitHubProviderOptions } from "../src/provider.ts";
import type { GhRunner } from "../src/gh.ts";
import { createGitHubProvider as fromIndex } from "../src/index.ts";
import * as pkg from "../src/index.ts";
import {
  checksAllDone,
  checksEmpty,
  checksPending,
  checksWithFailure,
  prConflicted,
  prCreateOutput,
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
const isSnapshot = (args: string[]) => args.some((a) => a.includes("reviewThreads"));

function gitProviderWith(handler: (args: string[]) => string): {
  gitProvider: ReturnType<typeof createGitHubProvider>;
  calls: string[][];
} {
  const { run, calls } = fakeRunner(handler);
  const opts: GitHubProviderOptions = { run };
  return { gitProvider: createGitHubProvider("/repo", opts), calls };
}

describe("findPullRequest", () => {
  test("returns the full snapshot for an existing head branch", async () => {
    const { gitProvider, calls } = gitProviderWith((args) => {
      if (isPrList(args)) return JSON.stringify(prListHit);
      if (isSnapshot(args)) return JSON.stringify(snapshotOpenResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const pr = await gitProvider.findPullRequest("feat/x");
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
    const { gitProvider, calls } = gitProviderWith((args) => {
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

    const pr = await gitProvider.findPullRequest("feat/x");

    expect(pr?.number).toBe(42);
    expect(calls).toHaveLength(2);
  });

  test("returns null when no PR exists for the head", async () => {
    const { gitProvider } = gitProviderWith((args) => {
      if (isPrList(args)) return JSON.stringify(prListEmpty);
      throw new Error("should not snapshot when the list is empty");
    });
    expect(await gitProvider.findPullRequest("feat/none")).toBe(null);
  });
});

describe("openPullRequest", () => {
  test("creates the PR then returns its snapshot", async () => {
    const { gitProvider, calls } = gitProviderWith((args) => {
      if (isPrCreate(args)) return prCreateOutput;
      if (isSnapshot(args)) return JSON.stringify(snapshotOpenResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const input = { head: "feat/x", base: "main", title: "Add x", body: "Does x." };
    const pr = await gitProvider.openPullRequest(input);
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
    const { gitProvider } = gitProviderWith((args) => {
      if (isSnapshot(args)) return JSON.stringify(snapshotConflictedResponse);
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    const pr = await gitProvider.getPullRequest(prConflicted.number);
    expect(pr.mergeable).toBe("conflicted");
    expect(pr.checks).toEqual([{ name: "test", status: "completed", conclusion: "failure" }]);
  });
});

describe("public surface", () => {
  test("exports only createGitHubProvider at runtime (GhRunner is type-only)", () => {
    expect(Object.keys(pkg)).toEqual(["createGitHubProvider"]);
  });

  test("the index re-export is a GitProvider", () => {
    const gitProvider: GitProvider = fromIndex("/repo", { run: () => Promise.resolve("[]") });
    expect(typeof gitProvider.findPullRequest).toBe("function");
    expect(typeof gitProvider.openPullRequest).toBe("function");
    expect(typeof gitProvider.getPullRequest).toBe("function");
    expect(typeof gitProvider.getChecks).toBe("function");
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
    const pending = createGitHubProvider("/repo", { run }).getChecks(42);

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
    const result = await createGitHubProvider("/repo", { run }).getChecks(42).poll();
    expect(result).toEqual({ done: true, value: [] });
  });

  test("settles even when a completed check failed — the step decides pass/fail", async () => {
    const run: GhRunner = () => Promise.resolve(JSON.stringify(checksWithFailure));
    const result = await createGitHubProvider("/repo", { run }).getChecks(42).poll();
    expect(result.done).toBe(true);
  });
});

describe("error propagation", () => {
  test("a runner failure surfaces from each method", async () => {
    const run: GhRunner = () => Promise.reject(new Error("gh boom"));
    const gitProvider = createGitHubProvider("/repo", { run });

    for (const call of [
      () => gitProvider.findPullRequest("x"),
      () => gitProvider.getPullRequest(1),
      () => gitProvider.openPullRequest({ head: "x", base: "main", title: "t", body: "b" }),
      () => gitProvider.getChecks(1).poll(),
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
