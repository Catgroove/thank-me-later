// `ci-wait` — the last Step: poll the Forge's checks for the opened PR until they settle,
// then report each conclusion. Report-only in this release: a red check is logged, not a Run
// failure — reacting to it (re-entry / respond-comments) is deferred work. `getChecks` is a
// Pending the engine's `until` polls; `ctx.signal` cancels the wait.

import { defineStep, type Step } from "@tml/core";
import { pullRequest } from "../artifacts.ts";

/** CI poll cadence, in milliseconds: poll every 10s, give up after 30min. Tune as runs inform us. */
const EVERY_MS = 10_000;
const TIMEOUT_MS = 30 * 60_000;

export function ciWaitStep(): Step {
  return defineStep({
    name: "ci-wait",
    consumes: [pullRequest],
    async run(ctx) {
      const pr = ctx.read(pullRequest);
      const checks = await ctx.until(ctx.forge.getChecks(pr.number), {
        every: EVERY_MS,
        timeout: TIMEOUT_MS,
      });
      for (const check of checks) {
        ctx.log(`ci: ${check.name} → ${check.conclusion ?? check.status}`);
      }
      return {};
    },
  });
}
