// `tmlDefaults` — the blessed default pipeline as a Plugin (ADR-0006). The eight Steps in
// order: branch → format → lint → typecheck → test → review → open-pr → ci-wait. No
// Providers (the host wires Forge + Harness) and no models (portable by referencing nothing).
// The Branch mode (ADR-0012) selects how the first Step gets a feature branch; it defaults to
// `ai`.

import { definePlugin, type Plugin } from "@tml/core";
import { ciWaitStep } from "./steps/ci-wait.ts";
import { formatStep, lintStep, testStep, typecheckStep } from "./steps/check.ts";
import { type BranchMode, branchStep } from "./steps/branch.ts";
import { openPrStep } from "./steps/open-pr.ts";
import { reviewStep } from "./steps/review.ts";

export interface DefaultsOptions {
  /** How the `branch` Step gets a feature branch when you aren't on one — defaults to `ai`. */
  readonly branch?: BranchMode;
}

export function tmlDefaults(opts: DefaultsOptions = {}): Plugin {
  return definePlugin({
    name: "@tml/defaults",
    steps: [
      branchStep(opts.branch),
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
