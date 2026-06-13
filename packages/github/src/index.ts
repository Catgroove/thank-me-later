// @tml/github — the GitHub Forge provider (ADR-0005). `createGitHubForge(cwd)`
// implements core's `Forge` by shelling out to the `gh` CLI; `gh` owns auth and
// repo detection. The canonical lifecycle entities (PullRequest, CheckRun,
// ReviewThread, mergeable) live in @tml/core — this package only maps onto them.

export { createGitHubForge } from "./forge.ts";
export type { GhRunner } from "./gh.ts";
