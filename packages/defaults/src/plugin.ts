// `tmlDefaults` — the blessed default pipeline as a Plugin. In order:
//   branch → describe → commit(the change) → {format,lint,typecheck,test}+commit
//          → review+commit → open-pr → ci-wait
// The work lands as a clean history — your change, then tml's fixes in their own commits.
// No Providers (the host wires Forge + Harness) and no models (portable by referencing nothing).
// The Branch mode selects how the first Step gets a feature branch; it defaults to `ai`.

import { definePlugin, type Plugin } from "@tml/core";
import { prTitle } from "./artifacts.ts";
import { type BranchMode, branchStep } from "./steps/branch.ts";
import { ciWaitStep } from "./steps/ci-wait.ts";
import { formatStep, lintStep, testStep, typecheckStep } from "./steps/check.ts";
import { commitGroup, commitStep } from "./steps/commit.ts";
import { describeStep } from "./steps/describe.ts";
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
      describeStep(),
      commitStep("commit-change", prTitle), // your work, subject = the PR title
      ...commitGroup(formatStep(), lintStep(), typecheckStep(), testStep()),
      ...commitGroup(reviewStep()),
      openPrStep(),
      ciWaitStep(),
    ],
  });
}
