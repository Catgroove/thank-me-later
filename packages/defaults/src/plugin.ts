// `tmlDefaults` — the blessed default pipeline as a Plugin (ADR-0006). The eight Steps in
// order: branch → format → lint → typecheck → test → review → open-pr → ci-wait. No
// Providers (the host wires Forge + Harness) and no models (portable by referencing nothing).

import { definePlugin, type Plugin } from "@tml/core";
import { ciWaitStep } from "./steps/ci-wait.ts";
import { formatStep, lintStep, testStep, typecheckStep } from "./steps/check.ts";
import { branchStep } from "./steps/branch.ts";
import { openPrStep } from "./steps/open-pr.ts";
import { reviewStep } from "./steps/review.ts";

export function tmlDefaults(): Plugin {
  return definePlugin({
    name: "@tml/defaults",
    steps: [
      branchStep(),
      formatStep(),
      lintStep(),
      typecheckStep(),
      testStep(),
      reviewStep(),
      openPrStep(),
      ciWaitStep(),
    ],
  });
}
