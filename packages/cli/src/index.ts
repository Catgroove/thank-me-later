#!/usr/bin/env bun

import {
  type Config,
  createEngine,
  createWorktree,
  type Engine,
  type EngineOptions,
  type Worktree,
} from "@tml/core";
import {
  createCliRenderer,
  createPlainRenderer,
  initialView,
  present,
  type Renderer,
} from "@tml/view";
import { buildShipConfig } from "./config.ts";

/** Seams, injected by tests; production uses the real worktree, config, and engine. */
export interface ShipDeps {
  cwd?: string;
  setupWorktree?: (cwd: string) => Promise<Worktree>;
  buildConfig?: (worktree: Worktree) => Config;
  engineFor?: (config: Config, opts: EngineOptions) => Engine;
  /** Override the renderer; defaults to TTY-vs-plain by `process.stdout.isTTY`. */
  renderer?: Renderer;
}

/** A TTY live region when stdout is a terminal; clean append-only lines otherwise (ADR-0011). */
function defaultRenderer(): Renderer {
  return process.stdout.isTTY
    ? createCliRenderer()
    : createPlainRenderer((line: string) => console.log(line));
}

export async function ship(deps: ShipDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const setupWorktree = deps.setupWorktree ?? createWorktree;
  const buildConfig = deps.buildConfig ?? buildShipConfig;
  const engineFor = deps.engineFor ?? createEngine;
  const renderer = deps.renderer ?? defaultRenderer();

  // Snapshot the live checkout into a disposable worktree and run the pipeline there, so the
  // user's checkout is untouched; dispose it whatever the outcome (ADR-0010).
  let worktree: Worktree | undefined;
  try {
    worktree = await setupWorktree(cwd);
    const engine = engineFor(buildConfig(worktree), { cwd: worktree.path });
    let view = initialView;
    let failed = false;
    let cancelled = false;
    // Fold each event into the shared ViewState, then let the renderer draw it (ADR-0011).
    for await (const event of engine.run()) {
      view = present(view, event);
      renderer.render(view, event);
      if (event.type === "run:failed") failed = true;
      if (event.type === "run:cancelled") cancelled = true;
    }
    // 130 = the conventional SIGINT exit code; an Abort is not a failure.
    return cancelled ? 130 : failed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    renderer.close(); // stop the spinner timer / clear the live region on every path
    await worktree?.dispose();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === "ship") return ship();
  console.error(`Unknown command: ${command ?? "(none)"}. Try: tml ship`);
  return 1;
}

// Only run the CLI when invoked directly — importing this module (e.g. from tests) must not
// trigger the command dispatch + process.exit.
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
