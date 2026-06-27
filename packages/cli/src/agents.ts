// `tml agents` - list the agents (Harnesses) tml knows about and which one is configured. It
// reports two distinct facts per agent: that it is *registered* (a built-in or a plugin called
// `registerHarness`) and whether its CLI is actually *installed* on this machine (the Harness's
// own `detect()`). The list is whatever the assembly registered, so a new built-in or a
// plugin-provided Harness appears here automatically - today that is just `pi`.

import { DEFAULT_HARNESS, type Harness } from "@tml/core";
import { assemble } from "./config.ts";
import { errorMessage } from "./error.ts";
import { type Loaded, loadTmlConfig } from "./load.ts";

/** Seams, injected by tests; production uses the real filesystem and console. */
export interface AgentsDeps {
  /** Where to read config from; defaults to process.cwd(). */
  cwd?: string;
  /** Config loader; defaults to the real `tml.json` loader. */
  load?: (cwd: string) => Loaded;
  /** Build the registered Harnesses for `cwd`; defaults to the real assembly. */
  harnessesFor?: (cwd: string, loaded: Loaded) => Promise<ReadonlyMap<string, Harness>>;
  /** Line sink for user-facing output; defaults to console.log. */
  log?: (line: string) => void;
  /** Error sink; defaults to console.error. */
  error?: (line: string) => void;
}

export async function agents(deps: AgentsDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const load = deps.load ?? loadTmlConfig;
  const harnessesFor =
    deps.harnessesFor ?? (async (dir, loaded) => (await assemble(dir, loaded)).harnesses());
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  try {
    const loaded = load(cwd);
    const harnesses = await harnessesFor(cwd, loaded);
    const configured = loaded.selection.harness ?? DEFAULT_HARNESS;

    log("Agents:");
    for (const [name, harness] of harnesses) {
      log(`  ${name}  ${await availability(harness)}${name === configured ? "  (default)" : ""}`);
    }
    // A configured harness that nothing registered is a misconfiguration; surface it rather than
    // silently omitting the agent tml would try (and fail) to use.
    if (!harnesses.has(configured)) {
      log(`  ${configured}  (default, not registered)`);
    }
    return 0;
  } catch (caught) {
    error(`tml agents: ${errorMessage(caught)}`);
    return 1;
  }
}

/** A one-line install status for an agent: where it was found, that it is missing, or unknown. */
async function availability(harness: Harness): Promise<string> {
  if (harness.detect === undefined) return "(detection unsupported)";
  const detection = await harness.detect();
  if (!detection.installed) return "not found";
  return detection.path !== undefined ? `installed (${detection.path})` : "installed";
}
