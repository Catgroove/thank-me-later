import { describe, expect, test } from "bun:test";

import type { Forge } from "@tml/core";

import { createGitHubForge, type GitHubForgeOptions } from "../src/forge.ts";
import type { GhRunner } from "../src/gh.ts";
import { createGitHubForge as fromIndex } from "../src/index.ts";
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
