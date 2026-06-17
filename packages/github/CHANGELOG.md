# @tml/github

## 1.0.0

### Patch Changes

- Updated dependencies [cafb140]
- Updated dependencies [d7ae10f]
  - @tml/core@0.1.0

## 0.1.0

### Minor Changes

- 8374c04: Implement the GitHub Forge provider. `createGitHubForge(cwd)` satisfies core's `Forge`
  by shelling out to the `gh` CLI (which owns auth + repo detection): `findPullRequest`
  (the ADR-0004 idempotency hook), `openPullRequest`, `getPullRequest`, and a pollable
  `getChecks`. A pure mapping layer maps `gh` GraphQL JSON onto the canonical lifecycle
  entities; the suite is hermetic via an injectable `GhRunner`, with an opt-in live smoke
  behind `TML_GH_LIVE=1`.
