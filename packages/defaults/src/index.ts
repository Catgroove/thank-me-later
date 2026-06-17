// @tml/defaults — the blessed default pipeline, shipped as just another Plugin built on the
// same @tml/core primitives (ARCHITECTURE). The pipeline is
//   branch → describe → commit(the change) → rebase → {format,lint,typecheck,test}+commit
//          → open-pr → review+commit → respond-comments+commit → push → ci-wait → merge-gate
// assembled by the `tmlDefaults` Plugin (an injected-API `(tml) => …`). Steps and artifact
// tokens are also exported so plugin authors can reuse or replace individual pieces. The plugin
// names no models (portable by referencing nothing) and supplies no Providers — the host wires
// Forge + Harness by name.

export {
  branchName,
  type MergeReadiness,
  mergeReadiness,
  prBody,
  prTitle,
  pullRequest,
  respondSummary,
  reviewSummary,
} from "./artifacts.ts";
export { default, tmlDefaults } from "./plugin.ts";
export { type BranchMode, branchNameFor, branchStep } from "./steps/branch.ts";
export { ciWaitStep } from "./steps/ci-wait.ts";
export { checkStep, formatStep, lintStep, testStep, typecheckStep } from "./steps/check.ts";
export { type CommitMessage, commitGroup, commitStep } from "./steps/commit.ts";
export { describeStep } from "./steps/describe.ts";
export { mergeGateStep } from "./steps/merge-gate.ts";
export { openPrStep } from "./steps/open-pr.ts";
export { pushStep } from "./steps/push.ts";
export { respondCommentsStep } from "./steps/respond-comments.ts";
export { reviewStep } from "./steps/review.ts";
