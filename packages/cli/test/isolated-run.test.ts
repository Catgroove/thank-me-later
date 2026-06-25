import { describe, expect, test } from "bun:test";
import {
  defineStep,
  type Config,
  type Engine,
  type EngineOptions,
  type RunEvent,
  type RunEventInput,
  type RunJournal,
  type RunJournalSnapshot,
} from "@tml/core";
import {
  type HandoffInput,
  inCheckoutIsolation,
  isolatedRun,
  type IsolatedRunContext,
  type IsolationAdapter,
  outcomeExitCode,
} from "../src/isolated-run.ts";

const stamp = (event: RunEventInput, i: number): RunEvent => ({ ...event, at: i }) as RunEvent;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

function engineYielding(events: RunEventInput[]): Engine {
  return {
    async *run(): AsyncGenerator<RunEvent> {
      for (const [i, event] of events.entries()) yield stamp(event, i);
    },
  };
}

/** An in-memory Run Journal; `meta` seeds the snapshot `begin` returns. */
function fakeJournal(meta: Partial<RunJournalSnapshot["metadata"]> = {}): RunJournal {
  const snapshot: RunJournalSnapshot = {
    metadata: {
      runId: "run-test",
      checkoutKey: "test",
      checkoutPath: "/repo",
      pipeline: [],
      status: "running",
      startedAt: "",
      updatedAt: "",
      completedSteps: [],
      workspacePath: "/repo/.worktree",
      ...meta,
    },
    artifacts: new Map(),
    completedSteps: new Set(meta.completedSteps ?? []),
    rounds: [],
    roundIndexes: new Map(),
  };
  return {
    begin: () => Promise.resolve(snapshot),
    recordResumeKey: () => Promise.resolve(),
    recordWorktreeHandoff: () => Promise.resolve(),
    recordArtifact: () => Promise.resolve(),
    recordStepCompleted: () => Promise.resolve(),
    recordRound: () => Promise.resolve(),
    recordEvent: () => Promise.resolve(),
    finish: () => Promise.resolve(),
  };
}

/** A recording engine factory: captures every `EngineOptions` and yields `plan(opts)` per pass. */
function recordingEngineFor(plan: (opts: EngineOptions) => RunEventInput[]): {
  readonly calls: EngineOptions[];
  readonly engineFor: (config: Config, opts: EngineOptions) => Engine;
} {
  const calls: EngineOptions[] = [];
  return {
    calls,
    engineFor: (_config, opts) => {
      calls.push(opts);
      return engineYielding(plan(opts));
    },
  };
}

/** A recording isolation adapter: logs each seam call and the workspace it hands phase 2. */
function recordingIsolation(workspacePath = "/work"): {
  readonly adapter: IsolationAdapter;
  readonly log: string[];
  readonly handoffs: HandoffInput[];
} {
  const log: string[] = [];
  const handoffs: HandoffInput[] = [];
  return {
    log,
    handoffs,
    adapter: {
      sourceResumeKey: () => {
        log.push("sourceResumeKey");
        return Promise.resolve("feature");
      },
      handoff: (input) => {
        log.push("handoff");
        handoffs.push(input);
        return Promise.resolve({
          path: workspacePath,
          finalize: () => {
            log.push("finalize");
            return Promise.resolve();
          },
        });
      },
    },
  };
}

const step = (name: string, isolate = false): ReturnType<typeof defineStep> =>
  defineStep({ name, ...(isolate ? { isolate: true } : {}), run: () => Promise.resolve({}) });

/** [branch, commit(isolate), review] — boundary at commit, source phase {branch, commit}. */
const boundaryConfig = (): Config =>
  ({ pipeline: [step("branch"), step("commit", true), step("review")], providers: {} }) as Config;

const approveFindings: NonNullable<EngineOptions["approveFindings"]> = () =>
  Promise.resolve({ action: "approve" });

function baseCtx(over: Partial<IsolatedRunContext>): IsolatedRunContext {
  return {
    cwd: "/repo",
    buildConfig: () => boundaryConfig(),
    engineFor: () => engineYielding([]),
    ask: () => Promise.resolve(""),
    approveFindings,
    signal: new AbortController().signal,
    journal: fakeJournal(),
    isolation: inCheckoutIsolation,
    emit: () => {},
    ...over,
  };
}

describe("isolatedRun", () => {
  test("no isolation boundary runs a single pass in the checkout", async () => {
    const iso = recordingIsolation();
    const { engineFor, calls } = recordingEngineFor(() => [
      { type: "run:started", pipeline: [] },
      { type: "run:finished" },
    ]);
    const config = { pipeline: [step("branch")], providers: {} } as Config;

    const outcome = await isolatedRun(
      config,
      baseCtx({ buildConfig: () => config, engineFor, isolation: iso.adapter }),
    );

    expect(outcomeExitCode(outcome)).toBe(0);
    expect(outcome.finished).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.stopAfter).toBeUndefined();
    expect(iso.log).toEqual(["sourceResumeKey"]); // never hands off
  });

  test("a boundary runs phase 1, hands off, then resumes phase 2 in the workspace", async () => {
    const events: RunEvent[] = [];
    const iso = recordingIsolation("/work");
    const { engineFor, calls } = recordingEngineFor((opts) =>
      opts.stopAfter !== undefined
        ? [
            { type: "run:started", pipeline: [] },
            { type: "step:finished", step: "branch" },
            { type: "step:finished", step: "commit" },
            { type: "run:paused", step: "commit" },
          ]
        : [{ type: "step:finished", step: "review" }, { type: "run:finished" }],
    );

    const outcome = await isolatedRun(
      boundaryConfig(),
      baseCtx({ engineFor, isolation: iso.adapter, emit: (e) => events.push(e) }),
    );

    expect(outcome.finished).toBe(true);
    expect(calls.length).toBe(2);
    // Phase 1: source checkout, pausing at the boundary.
    expect(calls[0]?.cwd).toBe("/repo");
    expect(calls[0]?.stopAfter).toBe("commit");
    // Phase 2: the handed-off workspace, replaying the source phase.
    expect(calls[1]?.cwd).toBe("/work");
    expect(calls[1]?.coalesceEvents?.suppressRunStarted).toBe(true);
    expect([...(calls[1]?.coalesceEvents?.replaySteps ?? [])]).toEqual(["branch", "commit"]);
    // Seam order, and the workspace reserved by the journal is finalized at the end.
    expect(iso.log).toEqual(["sourceResumeKey", "handoff", "finalize"]);
    expect(iso.handoffs[0]?.worktreePath).toBe("/repo/.worktree");
    // The pause is swallowed; the stream reads as one continuous run.
    expect(events.some((e) => e.type === "run:paused")).toBe(false);
    expect(events.at(-1)?.type).toBe("run:finished");
  });

  test("a resumed run whose boundary already completed skips phase 1", async () => {
    const iso = recordingIsolation("/work");
    const { engineFor, calls } = recordingEngineFor(() => [
      { type: "step:finished", step: "review" },
      { type: "run:finished" },
    ]);

    const outcome = await isolatedRun(
      boundaryConfig(),
      baseCtx({
        engineFor,
        isolation: iso.adapter,
        journal: fakeJournal({ completedSteps: ["branch", "commit"] }),
      }),
    );

    expect(outcome.finished).toBe(true);
    expect(calls.length).toBe(1); // phase 2 only
    expect(calls[0]?.coalesceEvents).toBeDefined();
    expect(iso.log).toEqual(["sourceResumeKey", "handoff", "finalize"]);
  });

  test("a phase-1 failure returns without handing off to a workspace", async () => {
    const iso = recordingIsolation();
    const { engineFor, calls } = recordingEngineFor((opts) =>
      opts.stopAfter !== undefined
        ? [
            { type: "run:started", pipeline: [] },
            { type: "run:failed", step: "branch", error: "boom" },
          ]
        : [{ type: "run:finished" }],
    );

    const outcome = await isolatedRun(
      boundaryConfig(),
      baseCtx({ engineFor, isolation: iso.adapter }),
    );

    expect(outcomeExitCode(outcome)).toBe(1);
    expect(outcome.failed).toBe(true);
    expect(calls.length).toBe(1);
    expect(iso.log).toEqual(["sourceResumeKey"]); // never handed off
  });

  test("the workspace is finalized even when phase 2 fails", async () => {
    const iso = recordingIsolation("/work");
    const { engineFor } = recordingEngineFor((opts) =>
      opts.stopAfter !== undefined
        ? [
            { type: "run:started", pipeline: [] },
            { type: "run:paused", step: "commit" },
          ]
        : [{ type: "run:failed", step: "review", error: "nope" }],
    );

    const outcome = await isolatedRun(
      boundaryConfig(),
      baseCtx({ engineFor, isolation: iso.adapter }),
    );

    expect(outcome.failed).toBe(true);
    expect(iso.log).toEqual(["sourceResumeKey", "handoff", "finalize"]);
  });

  test("a phase-2 pipeline that no longer matches the journal throws, after finalizing", async () => {
    const iso = recordingIsolation("/work");
    const { engineFor } = recordingEngineFor((opts) =>
      opts.stopAfter !== undefined
        ? [
            { type: "run:started", pipeline: [] },
            { type: "run:paused", step: "commit" },
          ]
        : [{ type: "run:finished" }],
    );
    const drifted = { pipeline: [step("different")], providers: {} } as Config;

    const error = await rejection(
      isolatedRun(
        boundaryConfig(),
        baseCtx({ buildConfig: () => drifted, engineFor, isolation: iso.adapter }),
      ),
    );
    expect(String(error)).toMatch(/does not match/);
    expect(iso.log).toContain("finalize");
  });

  test("the in-checkout adapter resumes phase 2 in the source checkout", async () => {
    const { engineFor, calls } = recordingEngineFor((opts) =>
      opts.stopAfter !== undefined
        ? [
            { type: "run:started", pipeline: [] },
            { type: "run:paused", step: "commit" },
          ]
        : [{ type: "run:finished" }],
    );
    const config = boundaryConfig();

    const outcome = await isolatedRun(
      config,
      baseCtx({ buildConfig: () => config, engineFor, isolation: inCheckoutIsolation }),
    );

    expect(outcome.finished).toBe(true);
    expect(calls[1]?.cwd).toBe("/repo"); // phase 2 ran in place, no worktree
  });
});
