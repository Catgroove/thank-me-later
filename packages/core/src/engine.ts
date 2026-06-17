// The headless engine. `createEngine` validates the assembled Pipeline up front
// and returns a Run whose `run()` is the single event stream. The engine is the
// Conductor: it owns the loop, threads declared artifacts between Steps, drives
// flow signals, and supplies `ctx` — including `ctx.git` natively, bound to the
// Run's working dir.
//
// Events are emitted *live* over an internal queue: a background
// driver runs the pipeline and `push`es events as they happen — including
// `agent:progress` mid-Step — while the generator yields them concurrently. A
// Run is cancellable via an `AbortSignal`; an aborted Run ends with
// `run:cancelled`, distinct from the `cancel()` flow signal a Step returns.

import type { Artifact } from "./artifact.ts";
import type { Ctx } from "./context.ts";
import type { RunEvent } from "./events.ts";
import type { Forge } from "./providers/forge.ts";
import { type Git, createGit } from "./providers/git.ts";
import type { AgentRunOpts, Harness } from "./providers/harness.ts";
import type { Config, ModelMap, Providers } from "./pipeline.ts";
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
  /** External abort: cancels the Run, ending it with `run:cancelled`. */
  signal?: AbortSignal;
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
  const { pipeline, providers, models } = config;
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

  // Validate configured model ids against the live Harness *before* the first Step,
  // but only when the Harness can list its models — otherwise we can't, so we don't.
  // Name-key validity was already checked synchronously at assembly (validate.ts).
  if (models !== undefined && providers.agent.listModels !== undefined) {
    let available: Set<string>;
    try {
      available = new Set(await providers.agent.listModels());
    } catch (error) {
      if (signal.aborted) return cancelled(queue);
      queue.push({ type: "run:failed", error: errorMessage(error) });
      queue.close();
      return;
    }
    if (signal.aborted) return cancelled(queue);
    // An empty list is not a usable allowlist (the Harness can't, or won't, enumerate) — skip
    // rather than reject every id. Only a non-empty list validates configured ids.
    for (const [key, id] of available.size === 0 ? [] : Object.entries(models)) {
      if (id === undefined || available.has(id)) continue;
      const where = key === "default" ? "models.default" : `models["${key}"]`;
      queue.push({
        type: "run:failed",
        error: `${where} is "${id}", which the Harness does not list as an available model.`,
      });
      queue.close();
      return;
    }
  }

  let i = 0;
  while (i < pipeline.length) {
    const step = pipeline[i];
    if (step === undefined) break;
    if (signal.aborted) return cancelled(queue, step.name);

    queue.push({ type: "step:started", step: step.name });
    const ctx = makeContext(step, store, providers, git, queue, ask, signal, models);

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
      const value = produced[artifact.name];
      store.set(artifact.name, value);
      // Relay the value's string form for presentation when it has one; non-string artifacts
      // (e.g. a PullRequest object — surfaced via `pr:opened`) carry no `rendered`.
      queue.push({
        type: "artifact:written",
        step: step.name,
        artifact: artifact.name,
        ...(typeof value === "string" ? { rendered: value } : {}),
      });
    }

    queue.push({ type: "step:finished", step: step.name });
    i += 1;
  }

  queue.push({ type: "run:finished" });
  queue.close();
}

function cancelled(queue: EventQueue<RunEvent>, step?: string): void {
  queue.push(step === undefined ? { type: "run:cancelled" } : { type: "run:cancelled", step });
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
  models: ModelMap | undefined,
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
      // Resolve the model most-specific-first: an in-code per-call `{ model }` wins, else the
      // per-Step config, else the run-wide default, else nothing (the Harness's own default).
      const model = runOpts?.model ?? models?.[step.name] ?? models?.default;
      return configured.run(task, {
        ...runOpts,
        ...(model !== undefined ? { model } : {}),
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

  // Wrap the Forge so the Run's pull request — freshly opened, or rediscovered on a re-run —
  // funnels a `pr:opened` event into the one event stream, the same way `agent` funnels progress.
  // The Step stays oblivious; consumers can surface the PR link at the end of the Run. The two
  // read-only methods are delegated verbatim (explicit delegation, not spread, so a class-based
  // Provider keeps its prototype methods).
  const base = providers.forge;
  const forge: Forge = {
    async openPullRequest(input) {
      const pr = await base.openPullRequest(input);
      queue.push({ type: "pr:opened", url: pr.url });
      return pr;
    },
    async findPullRequest(head) {
      const pr = await base.findPullRequest(head);
      if (pr) queue.push({ type: "pr:opened", url: pr.url });
      return pr;
    },
    getPullRequest: (prNumber) => base.getPullRequest(prNumber),
    getChecks: (prNumber) => base.getChecks(prNumber),
    updatePullRequestBody: (input) => base.updatePullRequestBody(input),
    createReviewThread: (input) => base.createReviewThread(input),
    replyToThread: (input) => base.replyToThread(input),
    resolveThread: (threadId) => base.resolveThread(threadId),
    submitReview: (input) => base.submitReview(input),
    lastReviewedSha: (prNumber) => base.lastReviewedSha(prNumber),
  };

  return {
    read: read as Ctx["read"],
    git,
    forge,
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
