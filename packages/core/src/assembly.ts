// The injected-API composition surface. A Plugin is a function `(tml) => …` that the host runs
// over a shared assembly: it appends/patches Steps and registers Providers by name. The host
// (the CLI) seeds the built-in Providers (`github`, `pi`) and runs the plugins —
// defaults → global → project — then calls `build()` to resolve the selected Provider names and
// produce the same `Config` the engine consumes.
//
// This is what lets a Plugin extend tml WITHOUT importing `@tml/core`: `defineStep`,
// `defineArtifact`, flow signals, the pipeline patch ops, and `register{GitProvider,Harness}` are
// all reachable off the injected `tml`. The declarative knobs (`tml.json`) arrive as `Selection`; JSON may only
// toggle/select (provider names, `branch`, `maxFixAttempts`, `models`, `disable`) - reshaping the
// pipeline (insert/replace/reorder) is a Plugin's job.

import { defineArtifact } from "./artifact.ts";
import type { Config, ModelMap, Providers } from "./pipeline.ts";
import type { GitProvider } from "./providers/git-provider.ts";
import type { Harness } from "./providers/harness.ts";
import { cancel, goto, retry, skip } from "./signals.ts";
import { type Step, defineStep } from "./step.ts";
import { AssemblyError } from "./validate.ts";

/** Builds a GitProvider bound to the Run's working dir. Registered by name; selected from `tml.json`. */
export type GitProviderFactory = (cwd: string) => GitProvider;
/** Builds a Harness bound to the Run's working dir. Registered by name; selected from `tml.json`. */
export type HarnessFactory = (cwd: string) => Harness;

/**
 * The declarative knobs from `tml.json` (merged global + project). Provider names default at
 * `build()` (`pi`/`github`). `branch` and `maxFixAttempts` are opaque here; their meaning belongs
 * to `@tml/defaults`, not the core.
 */
export interface Selection {
  readonly harness?: string;
  readonly gitProvider?: string;
  readonly branch?: string;
  readonly maxFixAttempts?: number;
  readonly models?: ModelMap;
  readonly disable?: readonly string[];
}

/** The read-only subset of `Selection` a Plugin may consult. */
export interface ResolvedKnobs {
  readonly branch?: string;
  readonly maxFixAttempts?: number;
}

/** The pipeline patch surface. Every reference to a Step by name throws `AssemblyError` if absent. */
export interface PipelineBuilder {
  append(...steps: Step[]): void;
  insertBefore(stepName: string, ...steps: Step[]): void;
  insertAfter(stepName: string, ...steps: Step[]): void;
  replace(stepName: string, step: Step): void;
  remove(stepName: string): void;
}

/** The API injected into every Plugin. A Plugin never imports `@tml/core`; it receives this. */
export interface Tml {
  /** Read-only merged declarative knobs from `tml.json`. */
  readonly config: ResolvedKnobs;
  readonly defineStep: typeof defineStep;
  readonly defineArtifact: typeof defineArtifact;
  readonly skip: typeof skip;
  readonly cancel: typeof cancel;
  readonly goto: typeof goto;
  readonly retry: typeof retry;
  readonly pipeline: PipelineBuilder;
  registerGitProvider(name: string, factory: GitProviderFactory): void;
  registerHarness(name: string, factory: HarnessFactory): void;
}

/** A pipeline extension: a function run over the injected `tml`. Authored with no core import. */
export type Plugin = (tml: Tml) => void | Promise<void>;

/** The host runs plugins over `tml`, then calls `build()` to get the assembled `Config`. */
export interface Assembly {
  readonly tml: Tml;
  build(): Config;
}

const DEFAULT_GIT_PROVIDER = "github";
const DEFAULT_HARNESS = "pi";

export function createAssembly(selection: Selection, cwd: string): Assembly {
  const steps: Step[] = [];
  const gitProviders = new Map<string, GitProviderFactory>();
  const harnesses = new Map<string, HarnessFactory>();

  const indexOf = (stepName: string): number => {
    const i = steps.findIndex((s) => s.name === stepName);
    if (i < 0) {
      throw new AssemblyError(
        `no Step named "${stepName}" in the pipeline (have: ${listSteps(steps)}).`,
      );
    }
    return i;
  };

  const pipeline: PipelineBuilder = {
    append(...add) {
      steps.push(...add);
    },
    insertBefore(stepName, ...add) {
      steps.splice(indexOf(stepName), 0, ...add);
    },
    insertAfter(stepName, ...add) {
      steps.splice(indexOf(stepName) + 1, 0, ...add);
    },
    replace(stepName, step) {
      steps.splice(indexOf(stepName), 1, step);
    },
    remove(stepName) {
      steps.splice(indexOf(stepName), 1);
    },
  };

  const tml: Tml = {
    config: {
      branch: selection.branch,
      maxFixAttempts: selection.maxFixAttempts,
    },
    defineStep,
    defineArtifact,
    skip,
    cancel,
    goto,
    retry,
    pipeline,
    registerGitProvider(name, factory) {
      gitProviders.set(name, factory);
    },
    registerHarness(name, factory) {
      harnesses.set(name, factory);
    },
  };

  return {
    tml,
    build(): Config {
      // Work on a copy so `build()` is idempotent (the shared `steps` is left intact).
      const out = [...steps];

      // `disable` is the ONLY pipeline mutation JSON can cause; an unknown name is an error.
      for (const name of new Set(selection.disable ?? [])) {
        const i = out.findIndex((s) => s.name === name);
        if (i < 0) {
          throw new AssemblyError(
            `disable: no Step named "${name}" in the pipeline (have: ${listSteps(out)}).`,
          );
        }
        out.splice(i, 1);
      }

      const gitProviderName = selection.gitProvider ?? DEFAULT_GIT_PROVIDER;
      const gitProvider = gitProviders.get(gitProviderName);
      if (gitProvider === undefined) {
        throw new AssemblyError(
          `gitProvider "${gitProviderName}" is not registered (have: ${listKeys(gitProviders)}).`,
        );
      }
      const harnessName = selection.harness ?? DEFAULT_HARNESS;
      const harness = harnesses.get(harnessName);
      if (harness === undefined) {
        throw new AssemblyError(
          `harness "${harnessName}" is not registered (have: ${listKeys(harnesses)}).`,
        );
      }

      const providers: Providers = { gitProvider: gitProvider(cwd), agent: harness(cwd) };
      const models = withoutDisabledModels(selection.models, selection.disable);
      return {
        pipeline: out,
        providers,
        ...(models !== undefined ? { models } : {}),
      };
    },
  };
}

function withoutDisabledModels(
  models: ModelMap | undefined,
  disabled: readonly string[] | undefined,
): ModelMap | undefined {
  if (models === undefined) return undefined;
  const disabledNames = new Set(disabled ?? []);
  const entries = Object.entries(models).filter(([key]) => !disabledNames.has(key));
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as ModelMap);
}

function listSteps(steps: readonly Step[]): string {
  return steps.length === 0 ? "(none)" : steps.map((s) => `"${s.name}"`).join(", ");
}

function listKeys(registry: ReadonlyMap<string, unknown>): string {
  const names = [...registry.keys()];
  return names.length === 0 ? "(none)" : names.map((n) => `"${n}"`).join(", ");
}
