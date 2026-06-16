// Composition surface: a Pipeline is an ordered list of Steps; a Config pairs it
// with the configured Providers; a Plugin contributes Steps and/or Providers and
// is composed explicitly in `tml.config.ts`. The blessed default pipeline is
// itself just a Plugin — not privileged by the core. The patch API
// (`override`/`insertAfter`) is deferred to when `@tml/defaults` lands.
//
// Git is NOT a configured Provider: there is exactly one git, so the
// engine supplies `ctx.git` natively, bound to the Run's working dir. Only Forge
// and Harness — which have genuine alternatives — are configured here.

import type { Forge } from "./providers/forge.ts";
import type { Harness } from "./providers/harness.ts";
import type { Step } from "./step.ts";

export type Pipeline = Step[];

export interface Providers {
  forge: Forge;
  agent: Harness;
}

export interface Plugin {
  name: string;
  steps?: Step[];
  providers?: Partial<Providers>;
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/**
 * Per-Step model selection. `default` is the run-wide floor; every other key is a
 * Step name. Resolution is most-specific-first: an in-code `{ model }` on a `ctx.agent.run`
 * call wins, else `models[stepName]`, else `models.default`, else the Harness's own default.
 * `@tml/*` plugins name no models — only a user's own config does. Values are raw,
 * harness-specific ids (no tiers/aliases); the engine passes them straight to the Harness.
 */
export type ModelMap = { default?: string } & Record<string, string>;

export interface Config {
  pipeline: Pipeline;
  providers: Providers;
  /** Optional per-Step model overrides; see {@link ModelMap}. Absent → harness defaults. */
  models?: ModelMap;
}

export function defineConfig(config: Config): Config {
  return config;
}
