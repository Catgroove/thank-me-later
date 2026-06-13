// Composition surface: a Pipeline is an ordered list of Steps; a Config pairs it
// with the configured Providers; a Plugin contributes Steps and/or Providers and
// is composed explicitly in `tml.config.ts`. The blessed default pipeline is
// itself just a Plugin — not privileged by the core. The patch API
// (`override`/`insertAfter`) is deferred to when `@tml/defaults` lands.
//
// Git is NOT a configured Provider (ADR-0007): there is exactly one git, so the
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

export interface Config {
  pipeline: Pipeline;
  providers: Providers;
}

export function defineConfig(config: Config): Config {
  return config;
}
