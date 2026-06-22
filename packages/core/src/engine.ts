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
import type { RunEvent } from "./events.ts";
import type { GitProvider } from "./providers/git-provider.ts";
import { type Git, createGit } from "./providers/git.ts";
import type { AgentRunOpts, Harness } from "./providers/harness.ts";
import type { Config, ModelMap, Providers } from "./pipeline.ts";
import { until } from "./pending.ts";
import { type EventQueue, createEventQueue } from "./queue.ts";
import type { RoundRecord, RoundRecordInput } from "./round.ts";
import { createRunJournal, type RunJournal, type RunJournalSnapshot } from "./run-journal.ts";
import { isFlowSignal } from "./signals.ts";
import type { Step } from "./step.ts";
import { validatePipeline } from "./validate.ts";

const MAX_RETRIES = 3;

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
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

  // The Run's abort signal: tripped by an external EngineOptions.signal, or by the
  // consumer abandoning the generator (the `finally` below). Providers observe it.
  const controller = new AbortController();
  const external = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });

  // Run the pipeline in the background, pushing events live. A truly unexpected
  // throw (the driver catches Step errors itself) still terminates the stream.
  const driver = drive(config, opts, queue, controller.signal).catch((error) =>
    failed(queue, opts.journal === false ? undefined : opts.journal, error),
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
  const cwd = opts.cwd ?? process.cwd();
  const git = opts.git ?? createGit(cwd);
  const journal =
    opts.journal === false ? undefined : (opts.journal ?? createRunJournal({ checkoutPath: cwd }));
  const snapshot = await journal?.begin({ pipeline: pipeline.map((s) => s.name) });
  const ask =
    opts.ask ??
    (() =>
      Promise.reject(
        new NotImplementedError(
          "headless ask (suspend to Git provider) is not implemented in this release",
        ),
      ));
  const approveFindings =
    opts.approveFindings ??
    (() =>
      Promise.reject(
        new NotImplementedError(
          "headless structured approval (suspend to Git provider) is not implemented in this release",
        ),
      ));

  const store = new Map<string, unknown>(snapshot?.artifacts);
  const stepByName = new Map<string, number>(pipeline.map((s, i): [string, number] => [s.name, i]));
  const retries = new Map<string, number>();
  const runRounds: RoundRecord[] = [...(snapshot?.rounds ?? [])];
  const roundIndexes = new Map<string, number>(snapshot?.roundIndexes);

  await emit(queue, journal, { type: "run:started", pipeline: pipeline.map((s) => s.name) });

  // Validate configured model ids against the live Harness *before* the first Step,
  // but only when the Harness can list its models - otherwise we can't, so we don't.
  // Name-key validity was already checked synchronously at assembly (validate.ts).
  if (models !== undefined && providers.agent.listModels !== undefined) {
    let available: Set<string>;
    try {
      available = new Set(await providers.agent.listModels());
    } catch (error) {
      if (signal.aborted) return cancelled(queue, journal);
      return failed(queue, journal, error);
    }
    if (signal.aborted) return cancelled(queue, journal);
    // An empty list is not a usable allowlist (the Harness can't, or won't, enumerate) - skip
    // rather than reject every id. Only a non-empty list validates configured ids.
    for (const [key, id] of available.size === 0 ? [] : Object.entries(models)) {
      if (id === undefined || available.has(id)) continue;
      const where = key === "default" ? "models.default" : `models["${key}"]`;
      return failed(
        queue,
        journal,
        `${where} is "${id}", which the Harness does not list as an available model.`,
      );
    }
  }

  let replayFromJournal = true;
  let i = 0;
  while (i < pipeline.length) {
    const step = pipeline[i];
    if (step === undefined) break;
    if (signal.aborted) return cancelled(queue, journal, step.name);

    if (step.resume === "reconcile") replayFromJournal = false;
    try {
      if (replayFromJournal && isStepReplayableFromJournal(step, snapshot)) {
        await emit(queue, journal, { type: "step:skipped", step: step.name });
        i += 1;
        continue;
      }
    } catch (error) {
      return failed(queue, journal, error, step.name);
    }

    await emit(queue, journal, { type: "step:started", step: step.name });
    const visibleRounds = runRounds.filter((round) => (stepByName.get(round.step) ?? Infinity) < i);
    const ctx = makeContext(
      step,
      store,
      providers,
      git,
      queue,
      ask,
      approveFindings,
      signal,
      models,
      journal,
      visibleRounds,
    );

    let result: Awaited<ReturnType<Step["run"]>>;
    try {
      result = await step.run(ctx);
    } catch (error) {
      // An abort surfaces here as a thrown AbortError (from until / the agent);
      // report it as a cancellation, not a failure.
      if (signal.aborted) return cancelled(queue, journal, step.name);
      return failed(queue, journal, error, step.name);
    }
    if (signal.aborted) return cancelled(queue, journal, step.name);

    if (isFlowSignal(result)) {
      switch (result.kind) {
        case "skip": {
          await journal?.recordStepCompleted(step.name);
          await emit(queue, journal, { type: "step:skipped", step: step.name });
          i += 1;
          continue;
        }
        case "cancel": {
          await journal?.finish("finished");
          await emit(queue, journal, { type: "run:finished" });
          queue.close();
          return;
        }
        case "goto": {
          const target = stepByName.get(result.step);
          if (target === undefined) {
            return failed(
              queue,
              journal,
              `goto target "${result.step}" is not a Step in the Pipeline`,
              step.name,
            );
          }
          await journal?.recordStepCompleted(step.name);
          await emit(queue, journal, { type: "step:finished", step: step.name });
          i = target;
          continue;
        }
        case "retry": {
          const n = (retries.get(step.name) ?? 0) + 1;
          if (n > MAX_RETRIES) {
            return failed(
              queue,
              journal,
              `Step "${step.name}" exceeded ${MAX_RETRIES} retries`,
              step.name,
            );
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
        return failed(
          queue,
          journal,
          `Step "${step.name}" returned undeclared artifact "${key}".`,
          step.name,
        );
      }
    }
    for (const artifact of step.produces) {
      if (!(artifact.name in produced)) {
        return failed(
          queue,
          journal,
          `Step "${step.name}" did not produce declared artifact "${artifact.name}".`,
          step.name,
        );
      }
      const value = produced[artifact.name];
      try {
        await journal?.recordArtifact({ step: step.name, artifact: artifact.name, value });
      } catch (error) {
        return failed(queue, journal, error, step.name);
      }
      store.set(artifact.name, value);
      // Relay the value's string form for presentation when it has one; non-string artifacts
      // (e.g. a PullRequest object - surfaced via `pr:opened`) carry no `rendered`.
      await emit(queue, journal, {
        type: "artifact:written",
        step: step.name,
        artifact: artifact.name,
        ...(typeof value === "string" ? { rendered: value } : {}),
      });
    }

    try {
      runRounds.push(...(await appendRounds(journal, roundIndexes, step.name, rounds)));
    } catch (error) {
      return failed(queue, journal, error, step.name);
    }

    await journal?.recordStepCompleted(step.name);
    await emit(queue, journal, { type: "step:finished", step: step.name });
    i += 1;
  }

  await journal?.finish("finished");
  await emit(queue, journal, { type: "run:finished" });
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

async function emit(
  queue: EventQueue<RunEvent>,
  journal: RunJournal | undefined,
  event: RunEvent,
): Promise<void> {
  await journal?.recordEvent(event).catch(() => undefined);
  queue.push(event);
}

async function failed(
  queue: EventQueue<RunEvent>,
  journal: RunJournal | undefined,
  error: unknown,
  step?: string,
): Promise<void> {
  await journal?.finish("failed").catch(() => undefined);
  const event: RunEvent =
    step === undefined
      ? { type: "run:failed", error: errorMessage(error) }
      : { type: "run:failed", step, error: errorMessage(error) };
  await journal?.recordEvent(event).catch(() => undefined);
  queue.push(event);
  queue.close();
}

async function cancelled(
  queue: EventQueue<RunEvent>,
  journal: RunJournal | undefined,
  step?: string,
): Promise<void> {
  await journal?.finish("cancelled").catch(() => undefined);
  const event: RunEvent =
    step === undefined ? { type: "run:cancelled" } : { type: "run:cancelled", step };
  await journal?.recordEvent(event).catch(() => undefined);
  queue.push(event);
  queue.close();
}

function makeContext(
  step: Step,
  store: Map<string, unknown>,
  providers: Providers,
  git: Git,
  queue: EventQueue<RunEvent>,
  ask: (prompt: string) => Promise<string>,
  approveFindings: (input: ApproveFindingsInput) => Promise<ApprovalDecision>,
  signal: AbortSignal,
  models: ModelMap | undefined,
  journal: RunJournal | undefined,
  visibleRounds: readonly RoundRecord[],
): Ctx {
  const read = (artifact: Artifact<unknown, string>): unknown => {
    if (!store.has(artifact.name)) {
      throw new Error(
        `Step "${step.name}" read artifact "${artifact.name}" before it was produced.`,
      );
    }
    return store.get(artifact.name);
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
          const event: RunEvent = { type: "agent:progress", step: step.name, progress };
          queue.push(event);
          void journal?.recordEvent(event).catch(() => undefined);
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
  const getMergeability = base.getMergeability?.bind(base);
  const getFailedCheckLogs = base.getFailedCheckLogs?.bind(base);
  const gitProvider: GitProvider = {
    async openPullRequest(input) {
      const pr = await base.openPullRequest(input);
      const event: RunEvent = { type: "pr:opened", url: pr.url };
      queue.push(event);
      void journal?.recordEvent(event).catch(() => undefined);
      return pr;
    },
    async findPullRequest(head) {
      const pr = await base.findPullRequest(head);
      if (pr) {
        const event: RunEvent = { type: "pr:opened", url: pr.url };
        queue.push(event);
        void journal?.recordEvent(event).catch(() => undefined);
      }
      return pr;
    },
    getPullRequest: (prNumber) => base.getPullRequest(prNumber),
    updatePullRequestBody: (input) => base.updatePullRequestBody(input),
    getChecks: (prNumber) => base.getChecks(prNumber),
    ...(getMergeability ? { getMergeability } : {}),
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
    ask(prompt: string) {
      const event: RunEvent = { type: "ask:pending", step: step.name, prompt };
      queue.push(event);
      void journal?.recordEvent(event).catch(() => undefined);
      return ask(prompt);
    },
    approveFindings(input: ApproveFindingsInput) {
      const event: RunEvent = { type: "approval:pending", step: step.name, input };
      queue.push(event);
      void journal?.recordEvent(event).catch(() => undefined);
      return approveFindings(input);
    },
    rounds(stepName?: string) {
      return stepName === undefined
        ? [...visibleRounds]
        : visibleRounds.filter((round) => round.step === stepName);
    },
    log(message: string) {
      const event: RunEvent = { type: "step:log", step: step.name, message };
      queue.push(event);
      void journal?.recordEvent(event).catch(() => undefined);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
