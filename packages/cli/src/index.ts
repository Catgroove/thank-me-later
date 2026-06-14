#!/usr/bin/env bun

import {
  type Config,
  createEngine,
  createWorktree,
  type Engine,
  type EngineOptions,
  type RunEvent,
  type Worktree,
} from "@tml/core";
import { buildShipConfig } from "./config.ts";

function formatEvent(event: RunEvent): string {
  switch (event.type) {
    case "run:started":
      return `▶ run started: ${event.pipeline.join(" → ")}`;
    case "step:started":
      return `  ▸ ${event.step}`;
    case "step:log":
      return `    · ${event.message}`;
    case "agent:progress": {
      const p = event.progress;
      return p.kind === "text"
        ? `    · ${p.text}`
        : `    ⚙ ${p.name} ${p.phase}${p.detail ? `: ${p.detail}` : ""}`;
    }
    case "artifact:written":
      return `    + ${event.artifact}`;
    case "step:skipped":
      return `  ⤼ ${event.step} (skipped)`;
    case "step:finished":
      return `  ✓ ${event.step}`;
    case "ask:pending":
      return `  ? ${event.step}: ${event.prompt}`;
    case "run:finished":
      return "■ run finished";
    case "run:cancelled":
      return `◼ run cancelled${event.step ? ` at ${event.step}` : ""}`;
    case "run:failed":
      return `✗ run failed${event.step ? ` at ${event.step}` : ""}: ${event.error}`;
  }
}

/** Seams, injected by tests; production uses the real worktree, config, and engine. */
export interface ShipDeps {
  cwd?: string;
  setupWorktree?: (cwd: string) => Promise<Worktree>;
  buildConfig?: (worktree: Worktree) => Config;
  engineFor?: (config: Config, opts: EngineOptions) => Engine;
  log?: (line: string) => void;
}

export async function ship(deps: ShipDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const setupWorktree = deps.setupWorktree ?? createWorktree;
  const buildConfig = deps.buildConfig ?? buildShipConfig;
  const engineFor = deps.engineFor ?? createEngine;
  const log = deps.log ?? ((line: string) => console.log(line));

  // Snapshot the live checkout into a disposable worktree and run the pipeline there, so the
  // user's checkout is untouched; dispose it whatever the outcome (ADR-0010).
  let worktree: Worktree | undefined;
  try {
    worktree = await setupWorktree(cwd);
    const engine = engineFor(buildConfig(worktree), { cwd: worktree.path });
    let failed = false;
    let cancelled = false;
    for await (const event of engine.run()) {
      log(formatEvent(event));
      if (event.type === "run:failed") failed = true;
      if (event.type === "run:cancelled") cancelled = true;
    }
    // 130 = the conventional SIGINT exit code; an Abort is not a failure.
    return cancelled ? 130 : failed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
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
