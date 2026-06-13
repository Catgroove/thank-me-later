// In-memory Provider doubles the engine is proven against. Forge and Harness
// have no real implementation in this release; these stand in for them. The Git
// Provider is real (see git.test.ts), so it has no fake here.

import type { Pending } from "../src/pending.ts";
import type { CheckRun, Forge, OpenPullRequestInput, PullRequest } from "../src/providers/forge.ts";
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
}

export interface FakeHarnessOptions {
  result?: AgentResult;
  settleAfter?: number;
  models?: string[];
  /** Emitted one-per-poll via `onProgress`, so progress interleaves with polling. */
  progress?: AgentProgress[];
}

export class FakeHarness implements Harness {
  readonly tasks: string[] = [];
  /** Set true once an in-flight `run` observes its `signal` aborting. */
  aborted = false;
  private readonly result: AgentResult;
  private readonly settleAfter: number;
  private readonly models: string[];
  private readonly progress: AgentProgress[];

  constructor(options: FakeHarnessOptions = {}) {
    this.result = options.result ?? { ok: true, summary: "done" };
    this.settleAfter = options.settleAfter ?? 1;
    this.models = options.models ?? [];
    this.progress = options.progress ?? [];
  }

  run(task: string, opts?: AgentRunOpts): Pending<AgentResult> {
    this.tasks.push(task);
    opts?.signal?.addEventListener(
      "abort",
      () => {
        this.aborted = true;
      },
      { once: true },
    );
    let calls = 0;
    const { progress, settleAfter, result } = this;
    return {
      poll() {
        calls += 1;
        const item = progress[calls - 1];
        if (item) opts?.onProgress?.(item);
        return Promise.resolve(
          calls >= settleAfter ? { done: true, value: result } : { done: false },
        );
      },
    };
  }

  listModels(): Promise<string[]> {
    return Promise.resolve(this.models);
  }
}
