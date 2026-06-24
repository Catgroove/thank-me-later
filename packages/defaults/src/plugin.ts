// `tmlDefaults` - the blessed default pipeline as an injected-API Plugin. In order:
//   branch → describe → commit(the change) │ rebase → format → lint → typecheck → test
//          → review → resync → open-pr → ci-wait → merge-gate
// The `│` marks the isolation boundary (carried on commit-change): branch/describe/commit-change run
// in the source checkout, then the host switches the checkout back to the default branch and hands
// the feature branch to a disposable worktree where the rest of the pipeline runs. The work lands as
// a clean history - your change, then tml's fixes in their own commits. Checks and review commit
// their auto-fixes through the core round executor. `rebase` runs once the change is committed
// (clean worktree) so the checks, review, and CI all see the freshly fetched base; `resync` rebases
// once more right before `open-pr` so the PR opens on the latest base even if it drifted during the
// slow checks/review phase. Turn either off with `disable: ["rebase"]` / `["resync"]` in tml.json.
// `merge-gate` runs last: after CI is green it confirms the host will actually let the PR merge (no
// conflicts, not behind, not blocked by branch protection, not a draft).
// It registers no Providers (the host wires Git provider + Harness by name) and names no models
// (portable by referencing nothing). Branch mode and the fix-attempt cap come from the merged
// `tml.json` knobs (`tml.config.branch`, `tml.config.maxFixAttempts`); branch defaults to `ai` and
// max fix attempts defaults to 3. @tml/defaults is first-party and bundled into the
// binary, so it imports its own step factories from @tml/core - only third-party local plugins
// are barred from importing the core.

import type { Plugin } from "@tml/core";
import { prTitle } from "./artifacts.ts";
import { BRANCH_MODES, type BranchMode, branchStep } from "./steps/branch.ts";
import { ciWaitStep } from "./steps/ci-wait.ts";
import { formatStep, lintStep, testStep, typecheckStep } from "./steps/check.ts";
import { commitStep } from "./steps/commit.ts";
import type { FixLoopPolicy } from "./steps/fix-loop.ts";
import { describeStep } from "./steps/describe.ts";
import { mergeGateStep } from "./steps/merge-gate.ts";
import { openPrStep } from "./steps/open-pr.ts";
import { rebaseStep, resyncStep } from "./steps/rebase.ts";
import { reviewStep } from "./steps/review.ts";

export const tmlDefaults: Plugin = (tml) => {
  const fixLoopPolicy: FixLoopPolicy = {
    maxAutoFixAttempts: asMaxFixAttempts(tml.config.maxFixAttempts),
  };
  tml.pipeline.append(
    branchStep(asBranchMode(tml.config.branch)),
    describeStep(),
    // The isolation boundary: branch/describe/commit-change run in the source checkout, then the
    // host hands the feature branch to a disposable worktree where the rest of the pipeline runs.
    { ...commitStep("commit-change", prTitle), isolate: true }, // your work, subject = the PR title
    rebaseStep(), // sync onto the latest base before the checks/review/CI run against it
    formatStep(fixLoopPolicy),
    lintStep(fixLoopPolicy),
    typecheckStep(fixLoopPolicy),
    testStep(fixLoopPolicy),
    reviewStep(fixLoopPolicy),
    resyncStep(), // re-sync onto the latest base before opening the PR (base may have drifted)
    openPrStep(),
    ciWaitStep(fixLoopPolicy),
    mergeGateStep(),
  );
};

export default tmlDefaults;

/** Narrow the opaque `branch` knob to a Branch mode; absent → `ai`, invalid → a clear error. */
function asBranchMode(value: string | undefined): BranchMode {
  if (value === undefined) return "ai";
  if ((BRANCH_MODES as readonly string[]).includes(value)) return value as BranchMode;
  throw new Error(`tml.json "branch" must be one of ${BRANCH_MODES.join(", ")} (got "${value}").`);
}

/** Narrow the opaque `maxFixAttempts` knob; absent -> 3, invalid -> a clear error. */
function asMaxFixAttempts(value: number | undefined): number {
  if (value === undefined) return 3;
  if (Number.isInteger(value) && value >= 0) return value;
  throw new Error(`tml.json "maxFixAttempts" must be a non-negative integer (got ${value}).`);
}
