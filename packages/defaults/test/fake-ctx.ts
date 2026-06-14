// Test doubles for unit-testing a single `step.run(ctx)` in isolation. Core's FakeForge /
// FakeHarness live in its test dir (not on its public surface), so the defaults package
// keeps its own minimal, call-recording fakes mirroring those shapes — plus a FakeGit
// (core's Git is real, so it ships no fake). `fakeCtx` assembles them into a `Ctx`.

import {
  type AgentResult,
  type AgentRunOpts,
  type Artifact,
  type CheckRun,
  type CommitResult,
  type Ctx,
  type Forge,
  type Git,
  type GitStatus,
  type Harness,
  type OpenPullRequestInput,
  type Pending,
  type PullRequest,
  until,
} from "@tml/core";

export class FakeGit implements Git {
  readonly calls: string[] = [];
  defaultBranchName = "main";
  currentBranchName = "HEAD";
  headShaValue = "abc1234";
  commitSha = "0".repeat(40);

  currentBranch(): Promise<string> {
    return Promise.resolve(this.currentBranchName);
  }
  defaultBranch(): Promise<string> {
    return Promise.resolve(this.defaultBranchName);
  }
  headSha(): Promise<string> {
    return Promise.resolve(this.headShaValue);
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
    return Promise.resolve({ branch: this.currentBranchName, staged: [], unstaged: [] });
  }
  push(opts?: { setUpstream?: boolean }): Promise<void> {
    this.calls.push(`push${opts?.setUpstream ? " -u" : ""}`);
    return Promise.resolve();
  }
}

/** Settles to `value` on the first poll (immediate). */
function settled<T>(value: T): Pending<T> {
  return { poll: () => Promise.resolve({ done: true as const, value }) };
}

export class FakeForge implements Forge {
  readonly opened: OpenPullRequestInput[] = [];
  /** When set, `findPullRequest` returns this (the idempotent-skip path). */
  existing: PullRequest | null = null;
  checks: CheckRun[] = [{ name: "ci", status: "completed", conclusion: "success" }];
  private nextNumber = 1;

  findPullRequest(_head: string): Promise<PullRequest | null> {
    return Promise.resolve(this.existing);
  }
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
    this.opened.push(input);
    const number = this.nextNumber++;
    return Promise.resolve({
      number,
      url: `https://forge.test/pr/${number}`,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      state: "open",
      mergeable: "mergeable",
      checks: this.checks,
      threads: [],
    });
  }
  getPullRequest(prNumber: number): Promise<PullRequest> {
    return Promise.reject(new Error(`fake forge stores no PR #${prNumber}`));
  }
  getChecks(_prNumber: number): Pending<CheckRun[]> {
    return settled(this.checks);
  }
}

export class FakeHarness implements Harness {
  readonly tasks: string[] = [];
  result: AgentResult = { ok: true, summary: "done" };

  run(task: string, _opts?: AgentRunOpts): Promise<AgentResult> {
    this.tasks.push(task);
    return Promise.resolve(this.result);
  }
}

export interface FakeCtxParts {
  git?: Git;
  forge?: Forge;
  agent?: Harness;
  /** Artifact-name → value, for `ctx.read`. */
  reads?: Record<string, unknown>;
  ask?: (prompt: string) => Promise<string>;
  signal?: AbortSignal;
}

export interface FakeCtxResult {
  ctx: Ctx;
  logs: string[];
  asks: string[];
}

export function fakeCtx(parts: FakeCtxParts = {}): FakeCtxResult {
  const logs: string[] = [];
  const asks: string[] = [];
  const reads = parts.reads ?? {};
  const signal = parts.signal ?? new AbortController().signal;
  const ask = parts.ask ?? ((_prompt: string) => Promise.resolve(""));

  const ctx: Ctx = {
    read(artifact) {
      const { name } = artifact as Artifact<unknown, string>;
      if (!(name in reads)) throw new Error(`fakeCtx: no read provided for artifact "${name}"`);
      return reads[name] as never;
    },
    git: parts.git ?? new FakeGit(),
    forge: parts.forge ?? new FakeForge(),
    agent: parts.agent ?? new FakeHarness(),
    signal,
    until: (pending, opts) => until(pending, { every: 1, ...opts, signal }),
    ask(prompt) {
      asks.push(prompt);
      return ask(prompt);
    },
    log(message) {
      logs.push(message);
    },
  };

  return { ctx, logs, asks };
}
