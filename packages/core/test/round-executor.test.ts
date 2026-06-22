import { describe, expect, test } from "bun:test";
import type { Ctx } from "../src/context.ts";
import {
  type CommitResult,
  type Git,
  type GitStatus,
  type RebaseResult,
} from "../src/providers/git.ts";
import { makeFinding, type Finding, type RoundRecordInput } from "../src/round.ts";
import {
  executeRoundLoop,
  type RoundCheckInput,
  type RoundFixInput,
} from "../src/round-executor.ts";
import { until } from "../src/pending.ts";
import { FakeGitProvider, FakeHarness } from "./fakes.ts";

class FakeGit implements Git {
  readonly calls: string[] = [];
  commitSha = "0".repeat(40);
  stagedFiles: string[] = [];

  currentBranch(): Promise<string> {
    return Promise.resolve("HEAD");
  }
  defaultBranch(): Promise<string> {
    return Promise.resolve("main");
  }
  headSha(): Promise<string> {
    return Promise.resolve("abc1234");
  }
  fetch(branch: string): Promise<void> {
    this.calls.push(`fetch ${branch}`);
    return Promise.resolve();
  }
  isAncestor(ancestor: string, ref: string): Promise<boolean> {
    this.calls.push(`isAncestor ${ancestor} ${ref}`);
    return Promise.resolve(false);
  }
  rebase(onto: string): Promise<RebaseResult> {
    this.calls.push(`rebase ${onto}`);
    return Promise.resolve({ status: "clean" });
  }
  rebaseAbort(): Promise<void> {
    this.calls.push("rebaseAbort");
    return Promise.resolve();
  }
  rebaseInProgress(): Promise<boolean> {
    return Promise.resolve(false);
  }
  createBranch(name: string): Promise<void> {
    this.calls.push(`createBranch ${name}`);
    return Promise.resolve();
  }
  checkout(name: string): Promise<void> {
    this.calls.push(`checkout ${name}`);
    return Promise.resolve();
  }
  stageAll(): Promise<void> {
    this.calls.push("stageAll");
    return Promise.resolve();
  }
  commit(message: string): Promise<CommitResult> {
    this.calls.push(`commit ${message}`);
    return Promise.resolve({ sha: this.commitSha });
  }
  status(): Promise<GitStatus> {
    return Promise.resolve({ branch: "HEAD", staged: this.stagedFiles, unstaged: [] });
  }
  discardChanges(): Promise<void> {
    this.calls.push("discardChanges");
    return Promise.resolve();
  }
  push(opts: { branch: string; force?: boolean }): Promise<void> {
    this.calls.push(`push ${opts.force ? "(force) " : ""}${opts.branch}`);
    return Promise.resolve();
  }
}

function fakeCtx(parts: { git?: Git } = {}): { ctx: Ctx; asks: string[] } {
  const asks: string[] = [];
  const signal = new AbortController().signal;
  return {
    asks,
    ctx: {
      read() {
        throw new Error("fakeCtx: no reads configured");
      },
      git: parts.git ?? new FakeGit(),
      gitProvider: new FakeGitProvider(),
      agent: new FakeHarness(),
      signal,
      until: (pending, opts) => until(pending, { every: 1, ...opts, signal }),
      ask(prompt) {
        asks.push(prompt);
        return Promise.resolve("");
      },
      log() {},
    },
  };
}

function finding(action: Finding["action"] = "auto-fix", title = "Fix me"): Finding {
  return makeFinding("round-executor", {
    severity: action === "ask-user" ? "error" : "warning",
    action,
    title,
    detail: `${title} detail`,
  });
}

describe("executeRoundLoop", () => {
  test("stops clean after one initial check", async () => {
    const checks: RoundCheckInput[] = [];
    const { ctx, asks } = fakeCtx();

    const result = await executeRoundLoop(ctx, {
      check(input) {
        checks.push(input);
        return Promise.resolve({ findings: [] });
      },
      fix() {
        throw new Error("fix should not run");
      },
      commitMessage: "chore: fix round findings",
    });

    expect(result).toEqual({
      stopReason: "clean",
      findings: [],
      rounds: [{ trigger: "initial", findings: [] }],
      attempts: 0,
    });
    expect(checks.map((c) => c.trigger)).toEqual(["initial"]);
    expect(asks).toEqual([]);
  });

  test("fixes selected findings, commits, then verifies fresh", async () => {
    const issue = finding();
    const git = new FakeGit();
    git.stagedFiles = ["src/file.ts"];
    git.commitSha = "abc".repeat(13) + "a";
    const { ctx } = fakeCtx({ git });
    const checkTriggers: string[] = [];
    const fixInputs: RoundFixInput[] = [];
    const firstHistory: RoundRecordInput[][] = [];

    const result = await executeRoundLoop(ctx, {
      check(input) {
        checkTriggers.push(input.trigger);
        firstHistory.push([...input.history]);
        return Promise.resolve({ findings: input.trigger === "initial" ? [issue] : [] });
      },
      fix(input) {
        fixInputs.push(input);
        return Promise.resolve({ summary: "fixed it" });
      },
      commitMessage: "chore: fix round findings",
    });

    expect(result.stopReason).toBe("clean");
    expect(result.attempts).toBe(1);
    expect(checkTriggers).toEqual(["initial", "verify"]);
    expect(fixInputs).toHaveLength(1);
    expect(fixInputs[0]?.attempt).toBe(1);
    expect(fixInputs[0]?.findings).toEqual([issue]);
    expect(fixInputs[0]?.history).toEqual([
      { trigger: "initial", findings: [issue], selectedFindingIds: [issue.id] },
    ]);
    expect(fixInputs[0]?.historyText).toContain("Round 0: initial");
    expect(fixInputs[0]?.historyText).toContain("Fix me");
    expect(firstHistory[1]).toEqual([
      { trigger: "initial", findings: [issue], selectedFindingIds: [issue.id] },
      {
        trigger: "auto_fix",
        findings: [issue],
        selectedFindingIds: [issue.id],
        fixSummary: "fixed it",
        commitSha: git.commitSha,
      },
    ]);
    expect(git.calls).toEqual(["stageAll", "commit chore: fix round findings"]);
    expect(result.rounds).toEqual([
      { trigger: "initial", findings: [issue], selectedFindingIds: [issue.id] },
      {
        trigger: "auto_fix",
        findings: [issue],
        selectedFindingIds: [issue.id],
        fixSummary: "fixed it",
        commitSha: git.commitSha,
      },
      { trigger: "verify", findings: [] },
    ]);
  });

  test("stops for user decision when no selected finding can be fixed", async () => {
    const issue = finding("ask-user", "Confirm contract");
    const { ctx, asks } = fakeCtx();

    const result = await executeRoundLoop(ctx, {
      check: () => Promise.resolve({ findings: [issue] }),
      fix() {
        throw new Error("fix should not run");
      },
      commitMessage: "chore: fix round findings",
    });

    expect(result.stopReason).toBe("needs_user");
    expect(result.findings).toEqual([issue]);
    expect(result.rounds).toEqual([{ trigger: "initial", findings: [issue] }]);
    expect(asks).toEqual([]);
  });

  test("stops when the auto-fix limit is hit", async () => {
    const issue = finding();
    const git = new FakeGit();
    git.stagedFiles = ["src/file.ts"];
    const { ctx } = fakeCtx({ git });
    let fixes = 0;

    const result = await executeRoundLoop(ctx, {
      check: () => Promise.resolve({ findings: [issue] }),
      fix: () => {
        fixes += 1;
        return Promise.resolve({ summary: `fix ${fixes}` });
      },
      commitMessage: ({ attempt }) => `chore: fix round findings ${attempt}`,
    });

    expect(result.stopReason).toBe("auto_fix_limit_hit");
    expect(result.attempts).toBe(3);
    expect(fixes).toBe(3);
    expect(result.rounds.map((r) => r.trigger)).toEqual([
      "initial",
      "auto_fix",
      "verify",
      "auto_fix",
      "verify",
      "auto_fix",
      "verify",
    ]);
  });

  test("stops without asking when only informational findings remain", async () => {
    const note = finding("no-op", "FYI");
    const { ctx, asks } = fakeCtx();

    const result = await executeRoundLoop(ctx, {
      check: () => Promise.resolve({ findings: [note] }),
      fix() {
        throw new Error("fix should not run");
      },
      commitMessage: "chore: fix round findings",
    });

    expect(result.stopReason).toBe("remaining_findings");
    expect(asks).toEqual([]);
  });
});
