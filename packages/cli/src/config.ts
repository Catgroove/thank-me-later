// Assemble the Config `tml ship` runs. Over the merged pipeline knobs from `tml.json`
// (`loaded.selection`) we seed the built-in Providers by name (GitHub Git provider, pi Harness), run the
// bundled `@tml/defaults` plugin first, then any local plugins the config referenced — each over
// the injected `tml` API — and `build()` resolves the selected Providers into the final Config.
//
// Plugins are loaded by dynamic `import()` of an absolute path: the binary's embedded runtime
// evaluates the `.ts`/`.js` file directly, so nothing is installed in the target repo, in any
// language. Built-ins are seeded before plugins so a plugin can override a Provider name or
// register a new one.

import { type Config, createAssembly, type Plugin } from "@tml/core";
import tmlDefaults from "@tml/defaults";
import { createGitHubProvider } from "@tml/github";
import { createPiHarness } from "@tml/pi";
import { errorMessage } from "./error.ts";
import type { Loaded } from "./load.ts";

export async function assembleShipConfig(cwd: string, loaded: Loaded): Promise<Config> {
  const assembly = createAssembly(loaded.selection, cwd);
  assembly.tml.registerGitProvider("github", createGitHubProvider);
  assembly.tml.registerHarness("pi", createPiHarness);

  // Defaults first (it seeds the pipeline), then global+project plugins patch over it. Load and
  // execute local plugins one-at-a-time so module evaluation and patching both follow tml.json order.
  await tmlDefaults(assembly.tml);
  for (const path of loaded.pluginPaths) {
    const plugin = await loadPlugin(path);
    try {
      await plugin(assembly.tml);
    } catch (error) {
      throw new Error(`tml: plugin ${path} failed: ${errorMessage(error)}`);
    }
  }

  return assembly.build();
}

async function loadPlugin(path: string): Promise<Plugin> {
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
}
