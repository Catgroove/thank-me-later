// `ci-wait` - the last Step: poll the Git provider's checks for the opened PR until they settle,
// then report each conclusion. Report-only in this release: a red check is logged, not a Run
// failure - reacting to it (re-entry / respond-comments) is deferred work. `getChecks` is a
// Pending the engine's `until` polls; `ctx.signal` cancels the wait.

import { defineStep, makeFinding, type CheckRun, type Step } from "@tml/core";
import { pullRequest } from "../artifacts.ts";

/** CI poll cadence, in milliseconds: poll every 10s, give up after 30min. Tune as runs inform us. */
const EVERY_MS = 10_000;
const TIMEOUT_MS = 30 * 60_000;

function findingForCheck(check: CheckRun) {
  const status = check.conclusion ?? check.status;
  if (check.status === "completed" && check.conclusion === "success") return null;
  if (check.status === "completed" && check.conclusion === "neutral") return null;
  return makeFinding("ci", {
    severity: check.status === "completed" ? "error" : "warning",
    action: "ask-user",
    title: `${check.name} did not pass`,
    detail: `CI reported ${status}.`,
    location: check.name,
  });
}

export function ciWaitStep(): Step {
  return defineStep({
    name: "ci-wait",
    consumes: [pullRequest],
    resume: "reconcile",
    async run(ctx) {
      const pr = ctx.read(pullRequest);
      const checks = await ctx.until(ctx.gitProvider.getChecks(pr.number), {
        every: EVERY_MS,
        timeout: TIMEOUT_MS,
      });
      for (const check of checks) {
        ctx.log(`ci: ${check.name} -> ${check.conclusion ?? check.status}`);
      }
      return {
        artifacts: {},
        rounds: [
          {
            trigger: "verify",
            findings: checks.flatMap((check) => {
              const finding = findingForCheck(check);
              return finding ? [finding] : [];
            }),
          },
        ],
      };
    },
  });
}
