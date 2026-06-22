// @tml/github — the GitHub Git provider. `createGitHubProvider(cwd)`
// implements core's `GitProvider` by shelling out to the `gh` CLI; `gh` owns auth and
// repo detection. The canonical lifecycle entities (PullRequest, CheckRun,
// ReviewThread, mergeable) live in @tml/core — this package only maps onto them.

export { createGitHubProvider } from "./provider.ts";
export type { GhRunner } from "./gh.ts";
