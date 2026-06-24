// Test doubles for unit-testing a single `step.run(ctx)` in isolation. Core's FakeGitProvider /
// FakeHarness live in its test dir (not on its public surface), so the defaults package
// keeps its own minimal, call-recording fakes mirroring those shapes - plus a FakeGit
// (core's Git is real, so it ships no fake). `fakeCtx` assembles them into a `Ctx`.

import {
  type AgentResult,
  type AgentRunOpts,
  type ApprovalDecision,
  type ApproveFindingsInput,
  type Artifact,
  type CheckRun,
  type CommitResult,
  type Ctx,
  type GitProvider,
  type Git,
  type GitStatus,
  type Harness,
  type MergeState,
  type OpenPullRequestInput,
  type Pending,
  type PullRequest,
  type RebaseResult,
  type RoundRecord,
  until,
} from "@tml/core";

export class FakeGit implements Git {
  readonly calls: string[] = [];
  defaultBranchName = "main";
  currentBranchName = "HEAD";
  headShaValue = "abc1234";
  readonly headShaByRef = new Map<string, string>();
  commitSha = "0".repeat(40);
  stagedFiles: string[] = [];
  unstagedFiles: string[] = [];
  /** `fetch` throws when set, modelling no/unreachable remote. */
  fetchThrows = false;
  /** Ancestry answers keyed `${ancestor}..${ref}`; absent → false. */
  readonly ancestry = new Map<string, boolean>();
  rebaseResult: RebaseResult = { status: "clean" };
  rebaseInProgressValue = false;

  currentBranch(): Promise<string> {
    return Promise.resolve(this.currentBranchName);
  }
  defaultBranch(): Promise<string> {
    return Promise.resolve(this.defaultBranchName);
  }
  headSha(ref = "HEAD"): Promise<string> {
    return Promise.resolve(this.headShaByRef.get(ref) ?? this.headShaValue);
  }
  fetch(branch: string): Promise<void> {
    this.calls.push(`fetch ${branch}`);
    return this.fetchThrows ? Promise.reject(new Error("no remote")) : Promise.resolve();
  }
  isAncestor(ancestor: string, ref: string): Promise<boolean> {
    this.calls.push(`isAncestor ${ancestor} ${ref}`);
    return Promise.resolve(this.ancestry.get(`${ancestor}..${ref}`) ?? false);
  }
  rebase(onto: string): Promise<RebaseResult> {
    this.calls.push(`rebase ${onto}`);
    return Promise.resolve(this.rebaseResult);
  }
  rebaseAbort(): Promise<void> {
    this.calls.push("rebaseAbort");
    return Promise.resolve();
  }
  rebaseInProgress(): Promise<boolean> {
    return Promise.resolve(this.rebaseInProgressValue);
  }
  createBranch(name: string, opts?: { from?: string }): Promise<void> {
    this.calls.push(opts?.from ? `createBranch ${name} from ${opts.from}` : `createBranch ${name}`);
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
    return Promise.resolve({
      branch: this.currentBranchName,
      staged: this.stagedFiles,
      unstaged: this.unstagedFiles,
    });
  }
  diffAgainst(base: string): Promise<string> {
    this.calls.push(`diffAgainst ${base}`);
    return Promise.resolve("diff --git a/file.ts b/file.ts\n+changed");
  }
  push(opts: { branch: string; force?: boolean }): Promise<void> {
    this.calls.push(`push ${opts.force ? "(force) " : ""}${opts.branch}`);
    return Promise.resolve();
  }
  discardChanges(): Promise<void> {
    this.calls.push("discardChanges");
    this.stagedFiles = [];
    this.unstagedFiles = [];
    return Promise.resolve();
  }
}

/** Settles to `value` on the first poll (immediate). */
function settled<T>(value: T): Pending<T> {
  return { poll: () => Promise.resolve({ done: true as const, value }) };
}

export class FakeGitProvider implements GitProvider {
  readonly opened: OpenPullRequestInput[] = [];
  readonly bodyUpdates: { prNumber: number; body: string }[] = [];
  /** When set, `findPullRequest` returns this (the idempotent-skip path). */
  existing: PullRequest | null = null;
  checks: CheckRun[] = [{ name: "ci", status: "completed", conclusion: "success" }];
  /** Merge-readiness the merge gate polls; `clean` is mergeable by default. */
  mergeStateStatus: MergeState = "clean";
  /** Whether the current user may bypass merge rules; the gate consults this for blocked/behind. */
  mergeBypass = false;
  private nextNumber = 1;

  findPullRequest(_head: string): Promise<PullRequest | null> {
    return Promise.resolve(this.existing);
  }
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
    this.opened.push(input);
    const number = this.nextNumber++;
    return Promise.resolve({
      number,
      url: `https://git-provider.test/pr/${number}`,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      state: "open",
      mergeable: "mergeable",
      mergeStateStatus: this.mergeStateStatus,
      checks: this.checks,
    });
  }
  getPullRequest(prNumber: number): Promise<PullRequest> {
    return Promise.reject(new Error(`fake Git provider stores no PR #${prNumber}`));
  }
  updatePullRequestBody(input: { prNumber: number; body: string }): Promise<void> {
    this.bodyUpdates.push(input);
    if (this.existing?.number === input.prNumber) {
      this.existing = { ...this.existing, body: input.body };
    }
    return Promise.resolve();
  }
  getChecks(_prNumber: number): Pending<CheckRun[]> {
    return settled(this.checks);
  }
  getMergeState(_prNumber: number): Pending<MergeState> {
    return settled(this.mergeStateStatus);
  }
  canBypassMerge(_branch: string): Promise<boolean> {
    return Promise.resolve(this.mergeBypass);
  }
}

export class FakeHarness implements Harness {
  readonly tasks: string[] = [];
  /** The `opts` of each `run` call, parallel to `tasks` - lets tests assert a `schema` was set. */
  readonly opts: (AgentRunOpts | undefined)[] = [];
  /** Default reply, used when no per-call response is scripted. */
  result: AgentResult = { ok: true, summary: "done" };
  /** Optional per-call replies, consumed in order; falls back to `result` once drained. */
  readonly responses: AgentResult[] = [];

  run(task: string, opts?: AgentRunOpts): Promise<AgentResult> {
    this.tasks.push(task);
    this.opts.push(opts);
    return Promise.resolve(this.responses.shift() ?? this.result);
  }
}

export interface FakeCtxParts {
  git?: Git;
  gitProvider?: GitProvider;
  agent?: Harness;
  /** Artifact-name → value, for `ctx.read`. */
  reads?: Record<string, unknown>;
  ask?: (prompt: string) => Promise<string>;
  approveFindings?: (input: ApproveFindingsInput) => Promise<ApprovalDecision>;
  rounds?: readonly RoundRecord[];
  signal?: AbortSignal;
  until?: Ctx["until"];
}

/** A phase opened on the fake ctx: its label and grouping, captured in invocation order. */
export interface PhaseCall {
  label: string;
  group?: string;
}

export interface FakeCtxResult {
  ctx: Ctx;
  logs: string[];
  asks: string[];
  approvals: ApproveFindingsInput[];
  phases: PhaseCall[];
  recordedRounds: RoundRecord[];
}

export function fakeCtx(parts: FakeCtxParts = {}): FakeCtxResult {
  const logs: string[] = [];
  const asks: string[] = [];
  const approvals: ApproveFindingsInput[] = [];
  const phases: PhaseCall[] = [];
  const recordedRounds: RoundRecord[] = [];
  const reads = parts.reads ?? {};
  const signal = parts.signal ?? new AbortController().signal;
  const ask = parts.ask ?? ((_prompt: string) => Promise.resolve(""));
  const approveFindings = parts.approveFindings ?? (() => Promise.resolve({ action: "approve" }));

  const ctx: Ctx = {
    read(artifact) {
      const { name } = artifact as Artifact<unknown, string>;
      if (!(name in reads)) throw new Error(`fakeCtx: no read provided for artifact "${name}"`);
      return reads[name] as never;
    },
    git: parts.git ?? new FakeGit(),
    gitProvider: parts.gitProvider ?? new FakeGitProvider(),
    agent: parts.agent ?? new FakeHarness(),
    signal,
    until: parts.until ?? ((pending, opts) => until(pending, { ...opts, every: 1, signal })),
    ask(prompt) {
      asks.push(prompt);
      return ask(prompt);
    },
    approveFindings(input) {
      approvals.push(input);
      return approveFindings(input);
    },
    rounds(stepName?: string) {
      const rounds = parts.rounds ?? [];
      return stepName === undefined
        ? [...rounds]
        : rounds.filter((round) => round.step === stepName);
    },
    recordRound(round) {
      const record = { ...round, step: "review", index: recordedRounds.length };
      recordedRounds.push(record);
      return Promise.resolve(record);
    },
    log(message) {
      logs.push(message);
    },
    phase(label, fn, opts) {
      phases.push({ label, ...(opts?.group !== undefined ? { group: opts.group } : {}) });
      return fn();
    },
  };

  return { ctx, logs, asks, approvals, phases, recordedRounds };
}
