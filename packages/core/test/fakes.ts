// In-memory Provider doubles the engine is proven against. GitProvider and Harness
// have no real implementation in this release; these stand in for them. The real Git
// capability is exercised in git.test.ts against a throwaway repo; this `FakeGit` keeps
// engine-level tests deterministic so they never depend on the ambient checkout's branch.

import { AbortError, type Pending } from "../src/pending.ts";
import type { CommitResult, Git, GitStatus, RebaseResult } from "../src/providers/git.ts";
import type {
  CheckRun,
  GitProvider,
  MergeState,
  OpenPullRequestInput,
  PullRequest,
} from "../src/providers/git-provider.ts";
import type {
  AgentProgress,
  AgentResult,
  AgentRunOpts,
  Harness,
} from "../src/providers/harness.ts";

/** A Pending that settles to `value` on its Nth poll (N = 1 means immediate). */
function pendingAfter<T>(polls: number, value: T): Pending<T> {
  let calls = 0;
  return {
    poll() {
      calls += 1;
      return Promise.resolve(calls >= polls ? { done: true, value } : { done: false });
    },
  };
}

/**
 * A no-op `Git` whose `currentBranch` is fixed (default "master"), so the engine reads a stable
 * branch instead of the test process's actual checkout. Pass "HEAD" to model a detached HEAD.
 */
export class FakeGit implements Git {
  constructor(private readonly branch = "master") {}

  currentBranch(): Promise<string> {
    return Promise.resolve(this.branch);
  }
  defaultBranch(): Promise<string> {
    return Promise.resolve("main");
  }
  headSha(): Promise<string> {
    return Promise.resolve("abc1234");
  }
  fetch(): Promise<void> {
    return Promise.resolve();
  }
  isAncestor(): Promise<boolean> {
    return Promise.resolve(false);
  }
  rebase(): Promise<RebaseResult> {
    return Promise.resolve({ status: "clean" });
  }
  rebaseAbort(): Promise<void> {
    return Promise.resolve();
  }
  rebaseInProgress(): Promise<boolean> {
    return Promise.resolve(false);
  }
  createBranch(): Promise<void> {
    return Promise.resolve();
  }
  checkout(): Promise<void> {
    return Promise.resolve();
  }
  checkoutDetached(): Promise<void> {
    return Promise.resolve();
  }
  stageAll(): Promise<void> {
    return Promise.resolve();
  }
  commit(): Promise<CommitResult> {
    return Promise.resolve({ sha: "0".repeat(40) });
  }
  status(): Promise<GitStatus> {
    return Promise.resolve({ branch: this.branch, staged: [], unstaged: [] });
  }
  diffAgainst(): Promise<string> {
    return Promise.resolve("");
  }
  discardChanges(): Promise<void> {
    return Promise.resolve();
  }
  push(): Promise<void> {
    return Promise.resolve();
  }
}

export interface FakeGitProviderOptions {
  checks?: CheckRun[];
  checksSettleAfter?: number;
}

export class FakeGitProvider implements GitProvider {
  private readonly prs = new Map<number, PullRequest>();
  private readonly byHead = new Map<string, number>();
  private nextNumber = 1;
  private readonly checks: CheckRun[];
  private readonly checksSettleAfter: number;

  constructor(options: FakeGitProviderOptions = {}) {
    this.checks = options.checks ?? [{ name: "ci", status: "completed", conclusion: "success" }];
    this.checksSettleAfter = options.checksSettleAfter ?? 1;
  }

  findPullRequest(head: string): Promise<PullRequest | null> {
    const number = this.byHead.get(head);
    return Promise.resolve(number === undefined ? null : (this.prs.get(number) ?? null));
  }

  openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
    const number = this.nextNumber;
    this.nextNumber += 1;
    const pr: PullRequest = {
      number,
      url: `https://git-provider.test/pr/${number}`,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      state: "open",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      checks: this.checks,
    };
    this.prs.set(number, pr);
    this.byHead.set(input.head, number);
    return Promise.resolve(pr);
  }

  getPullRequest(prNumber: number): Promise<PullRequest> {
    const pr = this.prs.get(prNumber);
    return pr === undefined ? Promise.reject(new Error(`no PR #${prNumber}`)) : Promise.resolve(pr);
  }

  updatePullRequestBody(input: { prNumber: number; body: string }): Promise<void> {
    const pr = this.prs.get(input.prNumber);
    if (pr === undefined) return Promise.reject(new Error(`no PR #${input.prNumber}`));
    this.prs.set(input.prNumber, { ...pr, body: input.body });
    return Promise.resolve();
  }

  getChecks(_prNumber = 1): Pending<CheckRun[]> {
    return pendingAfter(this.checksSettleAfter, this.checks);
  }

  getMergeState(prNumber = 1): Pending<MergeState> {
    const pr = this.prs.get(prNumber);
    return pendingAfter(1, pr?.mergeStateStatus ?? "clean");
  }
}

export interface FakeHarnessOptions {
  result?: AgentResult;
  models?: string[];
  /** Streamed via `onProgress` as `run` is called, before it resolves. */
  progress?: AgentProgress[];
  /**
   * When true, `run` never resolves on its own — only an Abort rejects it (with
   * `AbortError`). Models a long-running agent that an external interrupt ends,
   * the streaming analogue of the old `settleAfter: Infinity`.
   */
  blockUntilAborted?: boolean;
}

export class FakeHarness implements Harness {
  readonly tasks: string[] = [];
  /** The resolved `model` each `run` received (parallel to `tasks`); `undefined` = harness default. */
  readonly runModels: (string | undefined)[] = [];
  /** Set true once an in-flight `run` observes its `signal` aborting. */
  aborted = false;
  private readonly result: AgentResult;
  private readonly models: string[];
  private readonly progress: AgentProgress[];
  private readonly blockUntilAborted: boolean;

  constructor(options: FakeHarnessOptions = {}) {
    this.result = options.result ?? { ok: true, summary: "done" };
    this.models = options.models ?? [];
    this.progress = options.progress ?? [];
    this.blockUntilAborted = options.blockUntilAborted ?? false;
  }

  run(task: string, opts?: AgentRunOpts): Promise<AgentResult> {
    this.tasks.push(task);
    this.runModels.push(opts?.model);
    // Stream progress live, before resolving — proves consumers see it mid-Step.
    for (const item of this.progress) opts?.onProgress?.(item);

    const signal = opts?.signal;
    const markAborted = () => {
      this.aborted = true;
    };

    if (this.blockUntilAborted) {
      return new Promise<AgentResult>((_resolve, reject) => {
        if (signal?.aborted) {
          markAborted();
          reject(new AbortError());
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            markAborted();
            reject(new AbortError());
          },
          { once: true },
        );
      });
    }

    signal?.addEventListener("abort", markAborted, { once: true });
    return Promise.resolve(this.result);
  }

  listModels(): Promise<string[]> {
    return Promise.resolve(this.models);
  }
}
