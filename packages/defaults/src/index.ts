// @tml/defaults — the blessed default pipeline, shipped as just another Plugin built on the
// same @tml/core primitives (ARCHITECTURE; ADR-0006). The pipeline is
//   branch → format → lint → typecheck → test → review → open-pr → ci-wait
// assembled by `tmlDefaults()`. Steps and artifact tokens are also exported so plugin
// authors can reuse or replace individual pieces. The plugin names no models (portable by
// referencing nothing) and supplies no Providers — the host wires Forge + Harness.

export { branchName, pullRequest, reviewSummary } from "./artifacts.ts";
export { type DefaultsOptions, tmlDefaults } from "./plugin.ts";
export { type BranchMode, branchNameFor, branchStep } from "./steps/branch.ts";
export { ciWaitStep } from "./steps/ci-wait.ts";
export { checkStep, formatStep, lintStep, testStep, typecheckStep } from "./steps/check.ts";
export { openPrStep } from "./steps/open-pr.ts";
export { reviewStep } from "./steps/review.ts";
