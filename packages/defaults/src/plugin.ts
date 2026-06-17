// `tmlDefaults` — the blessed default pipeline as an injected-API Plugin. In order:
//   branch → describe → commit(the change) → rebase → {format,lint,typecheck,test}+commit
//          → open-pr → review+commit → respond-comments+commit → push → ci-wait → merge-gate
// The PR opens first so `review` can post onto the live PR; `respond-comments` then reconciles the
// PR's review threads. Both post-PR commit groups land with a single `push` before CI, and the
// terminal `merge-gate` reports readiness (it never merges). The work lands as a clean history —
// your change, then tml's fixes in their own commits. `rebase`
// runs once the change is committed (clean worktree) so the checks, review, and CI all see the
// freshly fetched base; turn it off with `disable: ["rebase"]` in tml.json.
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
import { mergeGateStep } from "./steps/merge-gate.ts";
import { openPrStep } from "./steps/open-pr.ts";
import { pushStep } from "./steps/push.ts";
import { rebaseStep } from "./steps/rebase.ts";
import { respondCommentsStep } from "./steps/respond-comments.ts";
import { reviewStep } from "./steps/review.ts";

const BRANCH_MODES: readonly BranchMode[] = ["ai", "auto", "require"];

export const tmlDefaults: Plugin = (tml) => {
  tml.pipeline.append(
    branchStep(asBranchMode(tml.config.branch)),
    describeStep(),
    commitStep("commit-change", prTitle), // your work, subject = the PR title
    rebaseStep(), // sync onto the latest base before the checks/review/CI run against it
    ...commitGroup(formatStep(), lintStep(), typecheckStep(), testStep()),
    openPrStep(), // open the PR first, so review can post onto the live PR
    ...commitGroup(reviewStep()),
    ...commitGroup(respondCommentsStep()), // reconcile the PR's unresolved review threads
    pushStep(), // land the post-PR fix commits on the open PR before CI looks at them
    ciWaitStep(),
    mergeGateStep(), // report readiness (never merges)
  );
};

export default tmlDefaults;

/** Narrow the opaque `branch` knob to a Branch mode; absent → `ai`, invalid → a clear error. */
function asBranchMode(value: string | undefined): BranchMode {
  if (value === undefined) return "ai";
  if ((BRANCH_MODES as readonly string[]).includes(value)) return value as BranchMode;
  throw new Error(`tml.json "branch" must be one of ${BRANCH_MODES.join(", ")} (got "${value}").`);
}
