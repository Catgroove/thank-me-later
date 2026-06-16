// The built-in default Config `tml ship` runs: the @tml/defaults pipeline paired with the
// real Providers (GitHub Forge + pi Harness), each bound to the checkout the Run executes in.
// Loading a user `tml.config.ts` (with this as the fallback) is a later spec.

import { type Config, defineConfig, type ModelMap } from "@tml/core";
import { type BranchMode, tmlDefaults } from "@tml/defaults";
import { createGitHubForge } from "@tml/github";
import { createPiHarness } from "@tml/pi";

export function buildShipConfig(cwd: string, branch: BranchMode = "ai", models?: ModelMap): Config {
  return defineConfig({
    pipeline: tmlDefaults({ branch }).steps ?? [],
    providers: {
      forge: createGitHubForge(cwd),
      agent: createPiHarness(cwd),
    },
    ...(models !== undefined ? { models } : {}),
  });
}
