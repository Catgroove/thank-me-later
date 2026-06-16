// Assemble the Config `tml ship` runs (ADR-0015). Over the merged `tml.json` knobs
// (`loaded.selection`) we seed the built-in Providers by name (GitHub Forge, pi Harness), run the
// bundled `@tml/defaults` plugin first, then any local plugins the config referenced — each over
// the injected `tml` API — and `build()` resolves the selected Providers into the final Config.
//
// Plugins are loaded by dynamic `import()` of an absolute path: the binary's embedded runtime
// evaluates the `.ts`/`.js` file directly, so nothing is installed in the target repo, in any
// language. Built-ins are seeded before plugins so a plugin can override a Provider name or
// register a new one.

import { type Config, createAssembly, type Plugin } from "@tml/core";
import tmlDefaults from "@tml/defaults";
import { createGitHubForge } from "@tml/github";
import { createPiHarness } from "@tml/pi";
import type { Loaded } from "./load.ts";

export async function assembleShipConfig(cwd: string, loaded: Loaded): Promise<Config> {
  const assembly = createAssembly(loaded.selection, cwd);
  assembly.tml.registerForge("github", createGitHubForge);
  assembly.tml.registerHarness("pi", createPiHarness);

  // Defaults first (it seeds the pipeline), then global+project plugins patch over it.
  const plugins: Plugin[] = [tmlDefaults, ...(await loadPlugins(loaded.pluginPaths))];
  for (const plugin of plugins) await plugin(assembly.tml);

  return assembly.build();
}

async function loadPlugins(paths: string[]): Promise<Plugin[]> {
  return Promise.all(
    paths.map(async (path) => {
      let mod: { default?: unknown };
      try {
        mod = (await import(path)) as { default?: unknown };
      } catch (error) {
        throw new Error(`tml: failed to load plugin ${path}: ${errorMessage(error)}`);
      }
      if (typeof mod.default !== "function") {
        throw new Error(`tml: plugin ${path} must \`export default\` a function: (tml) => { … }`);
      }
      return mod.default as Plugin;
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
