// Composition types: a Pipeline is an ordered list of Steps; a Config pairs it with the
// configured Providers (+ optional per-Step model overrides). The Config is *assembled* from
// Plugins over the injected `tml` API (see `assembly.ts`), not hand-written — there is no
// top-level `defineConfig`, and a Plugin is a function, not an object.
//
// Git is NOT a configured Provider: there is exactly one git, so the engine supplies `ctx.git`
// natively, bound to the Run's working dir. Only GitProvider and Harness — which have genuine
// alternatives — are configured here.

import type { GitProvider } from "./providers/git-provider.ts";
import type { Harness } from "./providers/harness.ts";
import type { Step } from "./step.ts";

export type Pipeline = Step[];

export interface Providers {
  gitProvider: GitProvider;
  agent: Harness;
}

/**
 * Per-Step model selection. `default` is the run-wide floor; every other key is a
 * Step name. Resolution is most-specific-first: an in-code `{ model }` on a `ctx.agent.run`
 * call wins, else `models[stepName]`, else `models.default`, else the Harness's own default.
 * `@tml/*` plugins name no models — only a user's own `tml.json` does. Values are raw,
 * harness-specific ids (no tiers/aliases); the engine passes them straight to the Harness.
 */
export type ModelMap = { default?: string } & Record<string, string>;

export interface Config {
  pipeline: Pipeline;
  providers: Providers;
  /** Optional per-Step model overrides; see {@link ModelMap}. Absent → harness defaults. */
  models?: ModelMap;
}
