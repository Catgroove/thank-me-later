// In-memory Provider doubles the engine is proven against. Forge and Harness
// have no real implementation in this release; these stand in for them. The Git
// Provider is real (see git.test.ts), so it has no fake here.

import { AbortError, type Pending } from "../src/pending.ts";
import type {
  CheckRun,
  Forge,
  OpenPullRequestInput,
  PullRequest,
  ReviewThread,
} from "../src/providers/forge.ts";
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

export interface FakeForgeOptions {
  checks?: CheckRun[];
  checksSettleAfter?: number;
}

export class FakeForge implements Forge {
  private readonly prs = new Map<number, PullRequest>();
  private readonly byHead = new Map<string, number>();
  private nextNumber = 1;
  private readonly checks: CheckRun[];
  private readonly checksSettleAfter: number;

  constructor(options: FakeForgeOptions = {}) {
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
      url: `https://forge.test/pr/${number}`,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      state: "open",
      mergeable: "mergeable",
      reviewDecision: null,
      headSha: "0".repeat(40),
      checks: this.checks,
      threads: [],
    };
    this.prs.set(number, pr);
    this.byHead.set(input.head, number);
    return Promise.resolve(pr);
  }

  getPullRequest(prNumber: number): Promise<PullRequest> {
    const pr = this.prs.get(prNumber);
    return pr === undefined ? Promise.reject(new Error(`no PR #${prNumber}`)) : Promise.resolve(pr);
  }

  getChecks(): Pending<CheckRun[]> {
    return pendingAfter(this.checksSettleAfter, this.checks);
  }

  // The engine never drives these write paths; stub them to satisfy the interface.
  updatePullRequestBody(): Promise<void> {
    return Promise.resolve();
  }
  createReviewThread(input: { prNumber: number; path: string; line: number; body: string }) {
    const thread: ReviewThread = {
      id: "RT_fake",
      path: input.path,
      line: input.line,
      body: input.body,
      resolved: false,
      comments: [{ author: "", body: input.body, reactions: { thumbsUp: 0, thumbsDown: 0 } }],
    };
    return Promise.resolve(thread);
  }
  replyToThread(): Promise<void> {
    return Promise.resolve();
  }
  resolveThread(): Promise<void> {
    return Promise.resolve();
  }
  submitReview(): Promise<void> {
    return Promise.resolve();
  }
  lastReviewedSha(): Promise<string | null> {
    return Promise.resolve(null);
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
