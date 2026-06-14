// The built-in default Config `tml ship` runs: the @tml/defaults pipeline paired with the
// real Providers (GitHub Forge + pi Harness), each bound to the worktree the Run executes in.
// Loading a user `tml.config.ts` (with this as the fallback) is a later spec.

import { type Config, defineConfig, type Worktree } from "@tml/core";
import { tmlDefaults } from "@tml/defaults";
import { createGitHubForge } from "@tml/github";
import { createPiHarness } from "@tml/pi";

export function buildShipConfig(worktree: Worktree): Config {
  return defineConfig({
    pipeline: tmlDefaults().steps ?? [],
    providers: {
      forge: createGitHubForge(worktree.path),
      agent: createPiHarness(worktree.path),
    },
  });
}
