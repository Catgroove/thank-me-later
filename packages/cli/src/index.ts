#!/usr/bin/env bun

import {
  type Config,
  createEngine,
  type Engine,
  type EngineOptions,
  createRunJournal,
  type RunJournal,
  type RunJournalResumeMode,
} from "@tml/core";
import {
  createCliRenderer,
  createPlainRenderer,
  initialView,
  present,
  type Renderer,
} from "@tml/view";
import { assembleShipConfig } from "./config.ts";
import { init } from "./init.ts";
import { loadTmlConfig } from "./load.ts";

/** Seams, injected by tests; production uses the real config and engine against the checkout. */
export interface ShipDeps {
  cwd?: string;
  /** Build the Config for `cwd`. Async in production (it imports local plugins). */
  buildConfig?: (cwd: string) => Config | Promise<Config>;
  engineFor?: (config: Config, opts: EngineOptions) => Engine;
  /** Override or disable the local Run Journal. Production creates one per checkout. */
  journal?: RunJournal | false;
  /** Journal selection policy when production creates the journal. Defaults to auto-resume. */
  journalResume?: RunJournalResumeMode;
  /** Exact run id for `journalResume: "exact"`, or a stable id for tests. */
  runId?: string;
  /** Seal the full per-step trail instead of the quiet, results-forward default (`--verbose`). */
  verbose?: boolean;
  /** Override the renderer; defaults to TTY-vs-plain by `process.stdout.isTTY`. */
  renderer?: Renderer;
}

/** A TTY live region when stdout is a terminal; clean append-only lines otherwise. */
function defaultRenderer(verbose: boolean): Renderer {
  return process.stdout.isTTY
    ? createCliRenderer({ verbose })
    : createPlainRenderer((line: string) => console.log(line), { verbose });
}

// 128 + signal number: the conventional exit code for a signal-terminated process.
const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export async function ship(deps: ShipDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const buildConfig =
    deps.buildConfig ?? ((dir: string) => assembleShipConfig(dir, loadTmlConfig(dir)));
  const engineFor = deps.engineFor ?? createEngine;
  const renderer = deps.renderer ?? defaultRenderer(deps.verbose ?? false);

  // On a signal (Ctrl-C, kill) Bun terminates the process without running the `finally`
  // below, so the renderer's teardown never fires and the terminal is left with a hidden
  // cursor and/or an open synchronized-output region — the renderer is the sole owner of
  // that state. Restore it on the way out, then re-exit with the conventional
  // code. opentui self-registers these inside its renderer; pi leaves it to the caller —
  // our renderer-owns-ANSI / CLI-owns-lifecycle split puts it here. Handlers are torn down
  // in `finally` so repeated in-process calls (tests) don't accumulate listeners.
  const signals = Object.keys(SIGNAL_EXIT);
  const onSignal = (signal: string): void => {
    try {
      renderer.close();
    } finally {
      process.exit(SIGNAL_EXIT[signal] ?? 1);
    }
  };
  for (const signal of signals) process.on(signal, onSignal);

  // tml ship runs in place: the pipeline branches, commits, and pushes in the user's own checkout
  // so the Providers and `ctx.git` all bind to `cwd`.
  try {
    const journal =
      deps.journal === false
        ? undefined
        : (deps.journal ??
          (deps.engineFor === undefined
            ? createRunJournal({
                checkoutPath: cwd,
                resume: deps.journalResume ?? "auto",
                ...(deps.runId ? { runId: deps.runId } : {}),
              })
            : undefined));
    const engine = engineFor(await buildConfig(cwd), { cwd, ...(journal ? { journal } : {}) });
    let view = initialView;
    let failed = false;
    let cancelled = false;
    // Fold each event into the shared ViewState, then let the renderer draw it.
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
    for (const signal of signals) process.off(signal, onSignal);
    renderer.close(); // stop the spinner timer / clear the live region on every path
  }
}

interface ShipArgs {
  readonly verbose: boolean;
  readonly journalResume?: RunJournalResumeMode;
  readonly runId?: string;
}

function parseShipArgs(args: string[]): ShipArgs {
  let verbose = false;
  let journalResume: RunJournalResumeMode | undefined;
  let runId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    if (arg === "--fresh") {
      journalResume = "fresh";
      continue;
    }
    if (arg === "--resume") {
      runId = args[i + 1];
      if (runId === undefined || runId.startsWith("-"))
        throw new Error("--resume requires a run id");
      journalResume = "exact";
      i += 1;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      runId = arg.slice("--resume=".length);
      if (runId.length === 0) throw new Error("--resume requires a run id");
      journalResume = "exact";
      continue;
    }
    throw new Error(`Unknown ship option: ${arg}`);
  }
  return { verbose, ...(journalResume ? { journalResume } : {}), ...(runId ? { runId } : {}) };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "ship") {
    let args: ShipArgs;
    try {
      args = parseShipArgs(rest);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    return ship(args);
  }
  if (command === "init") {
    const force = rest.includes("--force") || rest.includes("-f");
    return init({ force });
  }
  console.error(`Unknown command: ${command ?? "(none)"}. Try: tml ship | tml init`);
  return 1;
}

// Only run the CLI when invoked directly — importing this module (e.g. from tests) must not
// trigger the command dispatch + process.exit.
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
