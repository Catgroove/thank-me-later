// The headless engine. `createEngine` validates the assembled Pipeline up front
// (ADR-0003) and returns a Run whose `run()` is the single event stream
// (ADR-0002). The engine is the Conductor: it owns the loop, threads declared
// artifacts between Steps, drives flow signals, and supplies `ctx` — including
// `ctx.git` natively (ADR-0007), bound to the Run's working dir.

import type { Artifact } from "./artifact.ts";
import type { Ctx } from "./context.ts";
import type { RunEvent } from "./events.ts";
import { type Git, createGit } from "./providers/git.ts";
import type { Config, Providers } from "./pipeline.ts";
import { until } from "./pending.ts";
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

function makeContext(
  step: Step,
  store: Map<string, unknown>,
  providers: Providers,
  git: Git,
  buffered: RunEvent[],
  ask: (prompt: string) => Promise<string>,
): Ctx {
  const read = (artifact: Artifact<unknown, string>): unknown => {
    if (!store.has(artifact.name)) {
      throw new Error(
        `Step "${step.name}" read artifact "${artifact.name}" before it was produced.`,
      );
    }
    return store.get(artifact.name);
  };

  return {
    read: read as Ctx["read"],
    git,
    forge: providers.forge,
    agent: providers.agent,
    until,
    ask(prompt: string) {
      buffered.push({ type: "ask:pending", step: step.name, prompt });
      return ask(prompt);
    },
    log(message: string) {
      buffered.push({ type: "step:log", step: step.name, message });
    },
  };
}

async function* runPipeline(config: Config, opts: EngineOptions): AsyncGenerator<RunEvent> {
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

  yield { type: "run:started", pipeline: pipeline.map((s) => s.name) };

  let i = 0;
  while (i < pipeline.length) {
    const step = pipeline[i];
    if (step === undefined) break;

    yield { type: "step:started", step: step.name };

    const buffered: RunEvent[] = [];
    const ctx = makeContext(step, store, providers, git, buffered, ask);

    let result: Awaited<ReturnType<Step["run"]>>;
    try {
      result = await step.run(ctx);
    } catch (error) {
      yield* buffered;
      yield { type: "run:failed", step: step.name, error: errorMessage(error) };
      return;
    }
    yield* buffered;

    if (isFlowSignal(result)) {
      switch (result.kind) {
        case "skip": {
          yield { type: "step:skipped", step: step.name };
          i += 1;
          continue;
        }
        case "cancel": {
          yield { type: "run:finished" };
          return;
        }
        case "goto": {
          const target = stepByName.get(result.step);
          if (target === undefined) {
            yield {
              type: "run:failed",
              step: step.name,
              error: `goto target "${result.step}" is not a Step in the Pipeline`,
            };
            return;
          }
          yield { type: "step:finished", step: step.name };
          i = target;
          continue;
        }
        case "retry": {
          const n = (retries.get(step.name) ?? 0) + 1;
          if (n > MAX_RETRIES) {
            yield {
              type: "run:failed",
              step: step.name,
              error: `Step "${step.name}" exceeded ${MAX_RETRIES} retries`,
            };
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
        yield {
          type: "run:failed",
          step: step.name,
          error: `Step "${step.name}" returned undeclared artifact "${key}".`,
        };
        return;
      }
    }
    for (const artifact of step.produces) {
      if (!(artifact.name in produced)) {
        yield {
          type: "run:failed",
          step: step.name,
          error: `Step "${step.name}" did not produce declared artifact "${artifact.name}".`,
        };
        return;
      }
      store.set(artifact.name, produced[artifact.name]);
      yield { type: "artifact:written", step: step.name, artifact: artifact.name };
    }

    yield { type: "step:finished", step: step.name };
    i += 1;
  }

  yield { type: "run:finished" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
