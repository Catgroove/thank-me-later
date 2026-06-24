// The headless engine. `createEngine` validates the assembled Pipeline up front
// and returns a Run whose `run()` is the single event stream. The engine is the
// Conductor: it owns the loop, threads declared artifacts between Steps, drives
// flow signals, and supplies `ctx` - including `ctx.git` natively, bound to the
// Run's working dir.
//
// Events are emitted *live* over an internal queue: a background
// driver runs the pipeline and `push`es events as they happen - including
// `agent:progress` mid-Step - while the generator yields them concurrently. A
// Run is cancellable via an `AbortSignal`; an aborted Run ends with
// `run:cancelled`, distinct from the `cancel()` flow signal a Step returns.

import type { ApprovalDecision, ApproveFindingsInput } from "./approval.ts";
import type { Artifact } from "./artifact.ts";
import type { Ctx } from "./context.ts";
import type { RunEvent, RunEventInput } from "./events.ts";
import type { GitProvider } from "./providers/git-provider.ts";
import { type Git, createGit } from "./providers/git.ts";
import type { AgentRunOpts, Harness } from "./providers/harness.ts";
import type { Config, ModelMap, Providers } from "./pipeline.ts";
import { AbortError, until } from "./pending.ts";
import { type EventQueue, createEventQueue } from "./queue.ts";
import type { RoundRecord, RoundRecordInput } from "./round.ts";
import { createRunJournal, type RunJournal, type RunJournalSnapshot } from "./run-journal.ts";
import { isFlowSignal } from "./signals.ts";
import type { Step } from "./step.ts";
import { validatePipeline } from "./validate.ts";

const MAX_RETRIES = 3;

/** The cross-cutting dependencies every event-emitting helper needs, bundled so they thread through
 *  `emit`/`failed`/`cancelled`/`makeContext` as one value instead of three positional args. */
interface EngineEventCoalescing {
  readonly suppressRunStarted?: boolean;
  readonly replaySteps?: ReadonlySet<string>;
}

interface EngineRun {
  readonly queue: EventQueue<RunEvent>;
  readonly journal: RunJournal | undefined;
  readonly now: () => number;
  readonly coalescing?: EngineEventCoalescing;
}

export interface EngineOptions {
  /** Working dir for the native Git capability. Defaults to process.cwd(). */
  cwd?: string;
  /** Override the Git capability (tests). Defaults to createGit(cwd). */
  git?: Git;
  /** Inline responder for `ctx.ask`. Defaults to the unimplemented headless path. */
  ask?: (prompt: string) => Promise<string>;
  /** Inline responder for `ctx.approveFindings`. Defaults to the unimplemented headless path. */
  approveFindings?: (input: ApproveFindingsInput) => Promise<ApprovalDecision>;
  /** External abort: cancels the Run, ending it with `run:cancelled`. */
  signal?: AbortSignal;
  /** Local execution journal. Defaults to the out-of-tree file Run Journal; `false` disables. */
  journal?: RunJournal | false;
  /** Clock for the `at` timestamp stamped on every event. Defaults to `Date.now`; injectable for tests. */
  now?: () => number;
  /**
   * Halt the Run after the named Step completes, without finishing the journal. The host uses this
   * to pause at the isolation boundary, hand the work off to a worktree, then resume the same
   * journaled Run in a second pass (which replays the completed Steps from the journal). Absent: the
   * Run executes to completion as usual.
   */
  stopAfter?: string;
  /** Suppress host-coalesced resume events before they reach either the journal or consumers. */
  coalesceEvents?: {
    readonly suppressRunStarted?: boolean;
    readonly replaySteps?: ReadonlySet<string> | readonly string[];
  };
}

export interface Engine {
  run(): AsyncGenerator<RunEvent>;
}

export function createEngine(config: Config, opts: EngineOptions = {}): Engine {
  validatePipeline(config.pipeline, config.models); // throws AssemblyError before any side effect
  return {
    run() {
      return runPipeline(config, opts);
    },
  };
}

async function* runPipeline(config: Config, opts: EngineOptions): AsyncGenerator<RunEvent> {
  const queue = createEventQueue<RunEvent>();
  const now = opts.now ?? (() => Date.now());

  // The Run's abort signal: tripped by an external EngineOptions.signal, or by the
  // consumer abandoning the generator (the `finally` below). Providers observe it.
  const controller = new AbortController();
  const external = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });

  // Run the pipeline in the background, pushing events live. A truly unexpected
  // throw (the driver catches Step errors itself) still terminates the stream. This fallback uses
  // only an explicitly-injected journal (no default), as before drive owns the default it creates.
  const driver = drive(config, opts, queue, controller.signal).catch((error) =>
    failed({ queue, journal: opts.journal === false ? undefined : opts.journal, now }, error),
  );

  try {
    for await (const event of queue) yield event;
  } finally {
    controller.abort(); // consumer abandoned us: cancel any in-flight Provider work
    external?.removeEventListener("abort", onExternalAbort);
    await driver; // let the background work settle before we return
  }
}

async function drive(
  config: Config,
  opts: EngineOptions,
  queue: EventQueue<RunEvent>,
  signal: AbortSignal,
): Promise<void> {
  const { pipeline, providers, models } = config;
  const now = opts.now ?? (() => Date.now());
  const cwd = opts.cwd ?? process.cwd();
  const git = opts.git ?? createGit(cwd);
  const journal =
    opts.journal === false ? undefined : (opts.journal ?? createRunJournal({ checkoutPath: cwd }));
  const coalescing = eventCoalescing(opts.coalesceEvents);
  const run: EngineRun = { queue, journal, now, ...(coalescing ? { coalescing } : {}) };
  // The branch you're on scopes `auto` resume: a parked Run only resumes on the branch it was
  // shipping. We seed it at start and advance it as Steps move HEAD onto a feature branch.
  let resumeKey = await currentBranchOrUndefined(git);
  const snapshot = await journal?.begin({
    pipeline: pipeline.map((s) => s.name),
    ...(resumeKey !== undefined ? { resumeKey } : {}),
  });
  const syncResumeKey = async (): Promise<void> => {
    if (journal === undefined) return;
    const branch = await currentBranchOrUndefined(git);
    if (branch !== undefined && branch !== resumeKey) {
      resumeKey = branch;
      await journal.recordResumeKey(branch);
    }
  };
  const ask =
    opts.ask ??
    (() =>
      Promise.reject(
        new Error("headless ask (suspend to Git provider) is not implemented in this release"),
      ));
  const approveFindings =
    opts.approveFindings ??
    (() =>
      Promise.reject(
        new Error(
          "headless structured approval (suspend to Git provider) is not implemented in this release",
        ),
      ));

  const store = new Map<string, unknown>(snapshot?.artifacts);
  const stepByName = new Map<string, number>(pipeline.map((s, i): [string, number] => [s.name, i]));
  const retries = new Map<string, number>();
  const runRounds: RoundRecord[] = [...(snapshot?.rounds ?? [])];
  const roundIndexes = new Map<string, number>(snapshot?.roundIndexes);

  await emit(run, { type: "run:started", pipeline: pipeline.map((s) => s.name) });

  // Validate configured model ids against the live Harness *before* the first Step,
  // but only when the Harness can list its models - otherwise we can't, so we don't.
  // Name-key validity was already checked synchronously at assembly (validate.ts).
  if (models !== undefined && providers.agent.listModels !== undefined) {
    let available: Set<string>;
    try {
      available = new Set(await providers.agent.listModels());
    } catch (error) {
      if (signal.aborted) return cancelled(run);
      return failed(run, error);
    }
    if (signal.aborted) return cancelled(run);
    // An empty list is not a usable allowlist (the Harness can't, or won't, enumerate) - skip
    // rather than reject every id. Only a non-empty list validates configured ids.
    for (const [key, id] of available.size === 0 ? [] : Object.entries(models)) {
      if (id === undefined || available.has(id)) continue;
      const where = key === "default" ? "models.default" : `models["${key}"]`;
      return failed(
        run,
        `${where} is "${id}", which the Harness does not list as an available model.`,
      );
    }
  }

  // The isolation boundary: once the run advances past this Step, pause instead of continuing, so
  // the host can hand off to a worktree and resume this same journaled Run in a second pass.
  const stopIndex = opts.stopAfter !== undefined ? stepByName.get(opts.stopAfter) : undefined;

  let replayFromJournal = true;
  let i = 0;
  while (i < pipeline.length) {
    if (stopIndex !== undefined && i > stopIndex) {
      await emit(run, { type: "run:paused", step: opts.stopAfter as string });
      queue.close();
      return;
    }
    const step = pipeline[i];
    if (step === undefined) break;
    if (signal.aborted) return cancelled(run, step.name);

    if (step.resume === "reconcile") replayFromJournal = false;
    try {
      if (replayFromJournal && isStepReplayableFromJournal(step, snapshot)) {
        // Replay the durable facts as presentation events so a resumed Step shows its prior
        // artifacts, headline, and Round history - the view is event-sourced and would otherwise
        // render the Step empty. Mirrors the normal completion path (artifacts, then rounds).
        for (const artifact of step.produces) {
          const value = snapshot?.artifacts.get(artifact.name);
          await emitReplay(run, {
            type: "artifact:written",
            step: step.name,
            artifact: artifact.name,
            ...(typeof value === "string" ? { rendered: value } : {}),
          });
        }
        for (const round of snapshot?.rounds ?? []) {
          if (round.step !== step.name) continue;
          await emitReplay(run, { type: "round:recorded", step: step.name, round });
        }
        await emitReplay(run, { type: "step:skipped", step: step.name });
        i += 1;
        continue;
      }
    } catch (error) {
      return failed(run, error, step.name);
    }

    await emit(run, { type: "step:started", step: step.name });
    const visibleRounds = runRounds.filter((round) => (stepByName.get(round.step) ?? Infinity) < i);
    const recordStepRound = async (round: RoundRecordInput): Promise<RoundRecord> => {
      const [record] = await appendRounds(journal, roundIndexes, step.name, [round]);
      if (record === undefined) throw new Error("round recorder produced no record");
      await emit(run, { type: "round:recorded", step: step.name, round: record });
      runRounds.push(record);
      return record;
    };

    const ctx = makeContext(
      step,
      store,
      providers,
      git,
      run,
      ask,
      approveFindings,
      signal,
      models,
      visibleRounds,
      recordStepRound,
    );

    let result: Awaited<ReturnType<Step["run"]>>;
    try {
      result = await step.run(ctx);
    } catch (error) {
      // An abort surfaces here as a thrown AbortError (from until, the agent, or an open
      // ask/approval gate); report it as a cancellation, not a failure.
      if (signal.aborted) return cancelled(run, step.name);
      return failed(run, error, step.name);
    }
    if (signal.aborted) return cancelled(run, step.name);

    if (isFlowSignal(result)) {
      switch (result.kind) {
        case "skip": {
          await journal?.recordStepCompleted(step.name);
          await emit(run, { type: "step:skipped", step: step.name });
          i += 1;
          continue;
        }
        case "cancel": {
          await journal?.finish("finished");
          await emit(run, { type: "run:finished" });
          queue.close();
          return;
        }
        case "goto": {
          const target = stepByName.get(result.step);
          if (target === undefined) {
            return failed(
              run,
              `goto target "${result.step}" is not a Step in the Pipeline`,
              step.name,
            );
          }
          await journal?.recordStepCompleted(step.name);
          await emit(run, { type: "step:finished", step: step.name });
          i = target;
          continue;
        }
        case "retry": {
          const n = (retries.get(step.name) ?? 0) + 1;
          if (n > MAX_RETRIES) {
            return failed(run, `Step "${step.name}" exceeded ${MAX_RETRIES} retries`, step.name);
          }
          retries.set(step.name, n);
          continue;
        }
      }
    }

    const { artifacts: produced, rounds } = stepResultParts(result);
    const declared = new Set(step.produces.map((a) => a.name));
    for (const key of Object.keys(produced)) {
      if (!declared.has(key)) {
        return failed(run, `Step "${step.name}" returned undeclared artifact "${key}".`, step.name);
      }
    }
    for (const artifact of step.produces) {
      if (!(artifact.name in produced)) {
        return failed(
          run,
          `Step "${step.name}" did not produce declared artifact "${artifact.name}".`,
          step.name,
        );
      }
      const value = produced[artifact.name];
      try {
        await journal?.recordArtifact({ step: step.name, artifact: artifact.name, value });
      } catch (error) {
        return failed(run, error, step.name);
      }
      store.set(artifact.name, value);
      // Relay the value's string form for presentation when it has one; non-string artifacts
      // (e.g. a PullRequest object - surfaced via `pr:opened`) carry no `rendered`.
      await emit(run, {
        type: "artifact:written",
        step: step.name,
        artifact: artifact.name,
        ...(typeof value === "string" ? { rendered: value } : {}),
      });
    }

    try {
      // Surface each completed Round as a factual event before the Step finishes, so presenters
      // can render Findings and Round history without scraping Markdown or waiting on a gate.
      const recorded = await appendRounds(journal, roundIndexes, step.name, rounds);
      for (const round of recorded) {
        await emit(run, { type: "round:recorded", step: step.name, round });
      }
      runRounds.push(...recorded);
    } catch (error) {
      return failed(run, error, step.name);
    }

    await journal?.recordStepCompleted(step.name);
    // A Step may have moved HEAD onto a feature branch; keep the resume key pointed at it so a
    // re-run on that branch resumes this Run (and a fresh run elsewhere does not).
    await syncResumeKey();
    await emit(run, { type: "step:finished", step: step.name });
    i += 1;
  }

  await journal?.finish("finished");
  await emit(run, { type: "run:finished" });
  queue.close();
}

function isStepReplayableFromJournal(
  step: Step,
  snapshot: RunJournalSnapshot | undefined,
): boolean {
  if (snapshot === undefined || !snapshot.completedSteps.has(step.name)) return false;
  const missing = step.produces.filter((artifact) => !snapshot.artifacts.has(artifact.name));
  if (missing.length > 0) {
    throw new Error(
      `cannot replay Step "${step.name}" from the Run Journal: missing artifact "${missing[0]?.name}".`,
    );
  }
  return true;
}

function stepResultParts(result: unknown): {
  artifacts: Record<string, unknown>;
  rounds: readonly RoundRecordInput[];
} {
  if (isObject(result) && "rounds" in result && isObject(result.artifacts)) {
    const rounds = Array.isArray(result.rounds) ? result.rounds : [];
    return { artifacts: result.artifacts, rounds: rounds as readonly RoundRecordInput[] };
  }
  return { artifacts: result as Record<string, unknown>, rounds: [] };
}

async function appendRounds(
  journal: RunJournal | undefined,
  roundIndexes: Map<string, number>,
  step: string,
  rounds: readonly RoundRecordInput[],
): Promise<RoundRecord[]> {
  const records: RoundRecord[] = [];
  for (const round of rounds) {
    const index = roundIndexes.get(step) ?? 0;
    roundIndexes.set(step, index + 1);
    const record = { ...round, step, index };
    records.push(record);
    await journal?.recordRound(record);
  }
  return records;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Stamp an unstamped event with the engine clock - the single point where `at` is added. */
function stamp(event: RunEventInput, now: () => number): RunEvent {
  return { ...event, at: now() } as RunEvent;
}

async function emit(run: EngineRun, event: RunEventInput): Promise<void> {
  if (shouldCoalesce(event, run.coalescing)) return;
  await emitRecorded(run, event);
}

type ReplayEventInput = Extract<
  RunEventInput,
  { type: "artifact:written" | "round:recorded" | "step:skipped" }
>;

async function emitReplay(run: EngineRun, event: ReplayEventInput): Promise<void> {
  if (shouldCoalesceReplay(event, run.coalescing)) return;
  await emitRecorded(run, event);
}

async function emitRecorded(run: EngineRun, event: RunEventInput): Promise<void> {
  const stamped = stamp(event, run.now);
  await run.journal?.recordEvent(stamped).catch(() => undefined);
  run.queue.push(stamped);
}

function eventCoalescing(
  input: EngineOptions["coalesceEvents"],
): EngineEventCoalescing | undefined {
  if (input === undefined) return undefined;
  const replaySteps =
    input.replaySteps === undefined
      ? undefined
      : input.replaySteps instanceof Set
        ? input.replaySteps
        : new Set(input.replaySteps);
  return {
    ...(input.suppressRunStarted !== undefined
      ? { suppressRunStarted: input.suppressRunStarted }
      : {}),
    ...(replaySteps !== undefined ? { replaySteps } : {}),
  };
}

function shouldCoalesce(
  event: RunEventInput,
  coalescing: EngineEventCoalescing | undefined,
): boolean {
  if (coalescing === undefined) return false;
  if (event.type === "run:started") return coalescing.suppressRunStarted === true;
  return false;
}

function shouldCoalesceReplay(
  event: ReplayEventInput,
  coalescing: EngineEventCoalescing | undefined,
): boolean {
  return coalescing?.replaySteps?.has(event.step) === true;
}

async function failed(
  { queue, journal, now }: EngineRun,
  error: unknown,
  step?: string,
): Promise<void> {
  await journal?.finish("failed").catch(() => undefined);
  const event = stamp(
    step === undefined
      ? { type: "run:failed", error: errorMessage(error) }
      : { type: "run:failed", step, error: errorMessage(error) },
    now,
  );
  await journal?.recordEvent(event).catch(() => undefined);
  queue.push(event);
  queue.close();
}

async function cancelled({ queue, journal, now }: EngineRun, step?: string): Promise<void> {
  await journal?.finish("cancelled").catch(() => undefined);
  const event = stamp(
    step === undefined ? { type: "run:cancelled" } : { type: "run:cancelled", step },
    now,
  );
  await journal?.recordEvent(event).catch(() => undefined);
  queue.push(event);
  queue.close();
}

function makeContext(
  step: Step,
  store: Map<string, unknown>,
  providers: Providers,
  git: Git,
  run: EngineRun,
  ask: (prompt: string) => Promise<string>,
  approveFindings: (input: ApproveFindingsInput) => Promise<ApprovalDecision>,
  signal: AbortSignal,
  models: ModelMap | undefined,
  visibleRounds: readonly RoundRecord[],
  recordRound: (round: RoundRecordInput) => Promise<RoundRecord>,
): Ctx {
  const { queue, journal, now } = run;
  const read = (artifact: Artifact<unknown, string>): unknown => {
    if (!store.has(artifact.name)) {
      throw new Error(
        `Step "${step.name}" read artifact "${artifact.name}" before it was produced.`,
      );
    }
    return store.get(artifact.name);
  };

  let nextPhaseId = 0;

  // Live events the Step itself triggers (agent progress, PR open, ask/approval, log) go straight
  // onto the queue rather than through `emit` - they're fired from inside provider callbacks, not
  // the drive loop. They share the same stamping path so `at` is never forgotten.
  const pushEvent = (event: RunEventInput): void => {
    const stamped = stamp(event, now);
    queue.push(stamped);
    void journal?.recordEvent(stamped).catch(() => undefined);
  };

  // Wrap the configured Harness so progress flows into the one event stream and the
  // Run's signal is threaded automatically - Steps call `ctx.agent.run(task)` plain.
  const configured = providers.agent;
  const agent: Harness = {
    run(task: string, runOpts?: AgentRunOpts) {
      // Resolve the model most-specific-first: an in-code per-call `{ model }` wins, else the
      // per-Step config, else the run-wide default, else nothing (the Harness's own default).
      const model = runOpts?.model ?? models?.[step.name] ?? models?.default;
      return configured.run(task, {
        ...runOpts,
        ...(model !== undefined ? { model } : {}),
        onProgress: (progress) => {
          runOpts?.onProgress?.(progress);
          pushEvent({ type: "agent:progress", step: step.name, progress });
        },
        signal: runOpts?.signal ?? signal,
      });
    },
    ...(configured.listModels
      ? { listModels: () => configured.listModels?.() ?? Promise.resolve([]) }
      : {}),
  };

  // Wrap the Git provider so the Run's pull request - freshly opened, or rediscovered on a re-run -
  // funnels a `pr:opened` event into the one event stream, the same way `agent` funnels progress.
  // The Step stays oblivious; consumers can surface the PR link at the end of the Run. The two
  // read-only methods are delegated verbatim (explicit delegation, not spread, so a class-based
  // Provider keeps its prototype methods).
  const base = providers.gitProvider;
  const getMergeState = base.getMergeState.bind(base);
  const canBypassMerge = base.canBypassMerge?.bind(base);
  const getFailedCheckLogs = base.getFailedCheckLogs?.bind(base);
  const gitProvider: GitProvider = {
    async openPullRequest(input) {
      const pr = await base.openPullRequest(input);
      pushEvent({ type: "pr:opened", url: pr.url });
      return pr;
    },
    async findPullRequest(head) {
      const pr = await base.findPullRequest(head);
      if (pr) pushEvent({ type: "pr:opened", url: pr.url });
      return pr;
    },
    getPullRequest: (prNumber) => base.getPullRequest(prNumber),
    updatePullRequestBody: (input) => base.updatePullRequestBody(input),
    getChecks: (prNumber) => base.getChecks(prNumber),
    getMergeState,
    ...(canBypassMerge ? { canBypassMerge } : {}),
    ...(getFailedCheckLogs ? { getFailedCheckLogs } : {}),
  };

  return {
    read: read as Ctx["read"],
    git,
    gitProvider,
    agent,
    signal,
    until: (pending, untilOpts) =>
      until(pending, { ...untilOpts, signal: untilOpts?.signal ?? signal }),
    // A Step parked on a human decision is otherwise unreachable by the abort signal: the responder
    // Promise only settles when the operator answers. Race it against the signal so a cancel while a
    // gate is open rejects with AbortError - the drive loop's catch then ends the Run as cancelled,
    // the same way an aborted `until`/agent does.
    ask(prompt: string) {
      pushEvent({ type: "ask:pending", step: step.name, prompt });
      return abortable(ask(prompt), signal);
    },
    approveFindings(input: ApproveFindingsInput) {
      pushEvent({ type: "approval:pending", step: step.name, input });
      return abortable(approveFindings(input), signal);
    },
    rounds(stepName?: string) {
      return stepName === undefined
        ? [...visibleRounds]
        : visibleRounds.filter((round) => round.step === stepName);
    },
    recordRound,
    log(message: string) {
      pushEvent({ type: "step:log", step: step.name, message });
    },
    async phase(label, fn, opts) {
      const phaseId = `${step.name}:${++nextPhaseId}`;
      pushEvent({
        type: "phase:started",
        step: step.name,
        phaseId,
        phase: label,
        ...(opts?.group !== undefined ? { group: opts.group } : {}),
      });
      try {
        const result = await fn();
        pushEvent({
          type: "phase:finished",
          step: step.name,
          phaseId,
          phase: label,
          ...(opts?.group !== undefined ? { group: opts.group } : {}),
          findings: opts?.findings ? [...opts.findings(result)] : [],
          status: "ok",
        });
        return result;
      } catch (error) {
        pushEvent({
          type: "phase:finished",
          step: step.name,
          phaseId,
          phase: label,
          ...(opts?.group !== undefined ? { group: opts.group } : {}),
          findings: [],
          status: "error",
        });
        throw error;
      }
    },
  };
}

/**
 * Reject as soon as `signal` aborts, even while `promise` is still pending. Used to make the human
 * gates (`ctx.ask`/`ctx.approveFindings`) abort-aware: their responder Promises never settle on
 * their own, so without this a cancel issued while a gate is open would hang the Run. The underlying
 * Promise is left to settle on its own (it has no cancel path); we just stop awaiting it.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error as Error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The current git branch, or undefined when it can't be read (no repo, detached HEAD, error). */
async function currentBranchOrUndefined(git: Git): Promise<string | undefined> {
  try {
    const branch = await git.currentBranch();
    return branch === "HEAD" || branch.length === 0 ? undefined : branch;
  } catch {
    return undefined;
  }
}
