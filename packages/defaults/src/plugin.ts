// `tmlDefaults` — the blessed default pipeline as an injected-API Plugin. In order:
//   branch → describe → commit(the change) → {format,lint,typecheck,test}+commit
//          → review+commit → open-pr → ci-wait
// The work lands as a clean history — your change, then tml's fixes in their own commits.
// It registers no Providers (the host wires Forge + Harness by name) and names no models
// (portable by referencing nothing). The Branch mode comes from the merged `tml.json` knobs
// (`tml.config.branch`); it defaults to `ai`. @tml/defaults is first-party and bundled into the
// binary, so it imports its own step factories from @tml/core — only third-party local plugins
// are barred from importing the core.

import type { Plugin } from "@tml/core";
import { prTitle } from "./artifacts.ts";
import { type BranchMode, branchStep } from "./steps/branch.ts";
import { ciWaitStep } from "./steps/ci-wait.ts";
import { formatStep, lintStep, testStep, typecheckStep } from "./steps/check.ts";
import { commitGroup, commitStep } from "./steps/commit.ts";
import { describeStep } from "./steps/describe.ts";
import { openPrStep } from "./steps/open-pr.ts";
import { reviewStep } from "./steps/review.ts";

const BRANCH_MODES: readonly BranchMode[] = ["ai", "auto", "require"];

export const tmlDefaults: Plugin = (tml) => {
  tml.pipeline.append(
    branchStep(asBranchMode(tml.config.branch)),
    describeStep(),
    commitStep("commit-change", prTitle), // your work, subject = the PR title
    ...commitGroup(formatStep(), lintStep(), typecheckStep(), testStep()),
    ...commitGroup(reviewStep()),
    openPrStep(),
    ciWaitStep(),
  );
};

export default tmlDefaults;

/** Narrow the opaque `branch` knob to a Branch mode; absent → `ai`, invalid → a clear error. */
function asBranchMode(value: string | undefined): BranchMode {
  if (value === undefined) return "ai";
  if ((BRANCH_MODES as readonly string[]).includes(value)) return value as BranchMode;
  throw new Error(`tml.json "branch" must be one of ${BRANCH_MODES.join(", ")} (got "${value}").`);
}
