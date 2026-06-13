// The headless engine. `createEngine` validates the assembled Pipeline up front
// (ADR-0003) and returns a Run whose `run()` is the single event stream
// (ADR-0002). The engine is the Conductor: it owns the loop, threads declared
// artifacts between Steps, drives flow signals, and supplies `ctx` — including
// `ctx.git` natively (ADR-0007), bound to the Run's working dir.
//
// Events are emitted *live* over an internal queue (ADR-0008): a background
// driver runs the pipeline and `push`es events as they happen — including
// `agent:progress` mid-Step — while the generator yields them concurrently. A
// Run is cancellable via an `AbortSignal`; an aborted Run ends with
// `run:cancelled`, distinct from the `cancel()` flow signal a Step returns.

import type { Artifact } from "./artifact.ts";
import type { Ctx } from "./context.ts";
import type { RunEvent } from "./events.ts";
import { type Git, createGit } from "./providers/git.ts";
import type { AgentRunOpts, Harness } from "./providers/harness.ts";
import type { Config, Providers } from "./pipeline.ts";
import { until } from "./pending.ts";
import { type EventQueue, createEventQueue } from "./queue.ts";
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
  /** External abort: cancels the Run, ending it with `run:cancelled` (ADR-0008). */
  signal?: AbortSignal;
}

export interface Engine {
  run(): AsyncGenerator<RunEvent>;
}

export function createEngine(config: Config, opts: EngineOptions = {}): Engine {
  validatePipeline(config.pipeline); // throws AssemblyError before any side effect
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
  const driver = drive(config, opts, queue, controller.signal).catch((error) => {
    queue.push({ type: "run:failed", error: errorMessage(error) });
    queue.close();
  });

  try {
    for await (const event of queue) yield event;
  } finally {
    controller.abort(); // consumer abandoned us → cancel any in-flight Provider work
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
  const { pipeline, providers } = config;
  const git = opts.git ?? createGit(opts.cwd ?? process.cwd());
  const ask =
    opts.ask ??
    (() =>
      Promise.reject(
        new NotImplementedError(
          "headless ask (suspend-to-Forge) is not implemented in this release",
        ),
      ));

  const store = new Map<string, unknown>();
  const stepByName = new Map<string, number>(pipeline.map((s, i): [string, number] => [s.name, i]));
  const retries = new Map<string, number>();

  queue.push({ type: "run:started", pipeline: pipeline.map((s) => s.name) });

  let i = 0;
  while (i < pipeline.length) {
    const step = pipeline[i];
    if (step === undefined) break;
    if (signal.aborted) return cancelled(queue, step.name);

    queue.push({ type: "step:started", step: step.name });
    const ctx = makeContext(step, store, providers, git, queue, ask, signal);

    let result: Awaited<ReturnType<Step["run"]>>;
    try {
      result = await step.run(ctx);
    } catch (error) {
      // An abort surfaces here as a thrown AbortError (from until / the agent);
      // report it as a cancellation, not a failure.
      if (signal.aborted) return cancelled(queue, step.name);
      queue.push({ type: "run:failed", step: step.name, error: errorMessage(error) });
      queue.close();
      return;
    }
    if (signal.aborted) return cancelled(queue, step.name);

    if (isFlowSignal(result)) {
      switch (result.kind) {
        case "skip": {
          queue.push({ type: "step:skipped", step: step.name });
          i += 1;
          continue;
        }
        case "cancel": {
          queue.push({ type: "run:finished" });
          queue.close();
          return;
        }
        case "goto": {
          const target = stepByName.get(result.step);
          if (target === undefined) {
            queue.push({
              type: "run:failed",
              step: step.name,
              error: `goto target "${result.step}" is not a Step in the Pipeline`,
            });
            queue.close();
            return;
          }
          queue.push({ type: "step:finished", step: step.name });
          i = target;
          continue;
        }
        case "retry": {
          const n = (retries.get(step.name) ?? 0) + 1;
          if (n > MAX_RETRIES) {
            queue.push({
              type: "run:failed",
              step: step.name,
              error: `Step "${step.name}" exceeded ${MAX_RETRIES} retries`,
            });
            queue.close();
            return;
          }
          retries.set(step.name, n);
          continue;
        }
      }
    }

    const produced = result as Record<string, unknown>;
    const declared = new Set(step.produces.map((a) => a.name));
    for (const key of Object.keys(produced)) {
      if (!declared.has(key)) {
        queue.push({
          type: "run:failed",
          step: step.name,
          error: `Step "${step.name}" returned undeclared artifact "${key}".`,
        });
        queue.close();
        return;
      }
    }
    for (const artifact of step.produces) {
      if (!(artifact.name in produced)) {
        queue.push({
          type: "run:failed",
          step: step.name,
          error: `Step "${step.name}" did not produce declared artifact "${artifact.name}".`,
        });
        queue.close();
        return;
      }
      store.set(artifact.name, produced[artifact.name]);
      queue.push({ type: "artifact:written", step: step.name, artifact: artifact.name });
    }

    queue.push({ type: "step:finished", step: step.name });
    i += 1;
  }

  queue.push({ type: "run:finished" });
  queue.close();
}

function cancelled(queue: EventQueue<RunEvent>, step: string): void {
  queue.push({ type: "run:cancelled", step });
  queue.close();
}

function makeContext(
  step: Step,
  store: Map<string, unknown>,
  providers: Providers,
  git: Git,
  queue: EventQueue<RunEvent>,
  ask: (prompt: string) => Promise<string>,
  signal: AbortSignal,
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
  // Run's signal is threaded automatically — Steps call `ctx.agent.run(task)` plain.
  const configured = providers.agent;
  const agent: Harness = {
    run(task: string, runOpts?: AgentRunOpts) {
      return configured.run(task, {
        ...runOpts,
        onProgress: (progress) => {
          runOpts?.onProgress?.(progress);
          queue.push({ type: "agent:progress", step: step.name, progress });
        },
        signal: runOpts?.signal ?? signal,
      });
    },
    ...(configured.listModels
      ? { listModels: () => configured.listModels?.() ?? Promise.resolve([]) }
      : {}),
  };

  return {
    read: read as Ctx["read"],
    git,
    forge: providers.forge,
    agent,
    signal,
    until: (pending, untilOpts) =>
      until(pending, { ...untilOpts, signal: untilOpts?.signal ?? signal }),
    ask(prompt: string) {
      queue.push({ type: "ask:pending", step: step.name, prompt });
      return ask(prompt);
    },
    log(message: string) {
      queue.push({ type: "step:log", step: step.name, message });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
