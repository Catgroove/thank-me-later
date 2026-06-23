#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  createEngine,
  type Engine,
  type EngineOptions,
  createIsolatedWorkspace,
  createRunJournal,
  currentWorkspaceSourceBranch,
  removeIsolatedWorkspace,
  type RunJournal,
  type RunJournalResumeMode,
} from "@tml/core";
import {
  createTerminalRenderer,
  failingApproveResponder,
  failingAskResponder,
  initialView,
  type InteractiveRenderer,
  present,
  type Renderer,
} from "@tml/view";
import { assembleShipConfig } from "./config.ts";
import { init } from "./init.ts";
import { loadTmlConfig } from "./load.ts";

/** Seams, injected by tests; production snapshots the checkout into an isolated run workspace. */
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
  /** Force the append-only/inline terminal renderer instead of the full-screen TUI (`--plain`). */
  plain?: boolean;
  /** Whether stdout is a TTY. Defaults to `process.stdout.isTTY`; injected by tests. */
  isTTY?: boolean;
  /** Override the renderer; defaults to the TTY-vs-plain-vs-TUI selection below. */
  renderer?: Renderer;
  /** Build the full-screen TUI renderer. Behind a seam so non-TTY paths never initialize OpenTUI. */
  createTui?: (options: {
    onAbort: () => void;
  }) => Promise<InteractiveRenderer> | InteractiveRenderer;
}

/**
 * Pick the renderer for the Run. Non-TTY (pipes, CI) gets the append-only plain renderer;
 * `--plain` keeps the inline TTY renderer; an interactive TTY gets the full-screen TUI. The TUI is
 * built through `createTui` (a dynamic import by default) so the OpenTUI runtime is only loaded
 * when actually selected.
 */
async function selectRenderer(opts: {
  isTTY: boolean;
  plain: boolean;
  verbose: boolean;
  onAbort: () => void;
  createTui: NonNullable<ShipDeps["createTui"]>;
}): Promise<Renderer> {
  if (!opts.isTTY) return createTerminalRenderer({ plain: true, verbose: opts.verbose });
  if (opts.plain) return createTerminalRenderer({ verbose: opts.verbose });
  return opts.createTui({ onAbort: opts.onAbort });
}

/** Default TUI factory: dynamically imports the OpenTUI renderer so non-TTY paths never load it. */
async function defaultCreateTui(options: { onAbort: () => void }): Promise<InteractiveRenderer> {
  const { createTuiRenderer } = await import("@tml/view/tui");
  return createTuiRenderer(options);
}

// 128 + signal number: the conventional exit code for a signal-terminated process.
const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export async function ship(deps: ShipDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const buildConfig =
    deps.buildConfig ?? ((dir: string) => assembleShipConfig(dir, loadTmlConfig(dir)));
  const engineFor = deps.engineFor ?? createEngine;
  const verbose = deps.verbose ?? false;
  // Closing the TUI while the Run is active aborts it through this controller (ending the Run with
  // `run:cancelled`); plain/non-TTY renderers never trip it.
  const abortController = new AbortController();
  const renderer =
    deps.renderer ??
    (await selectRenderer({
      isTTY: deps.isTTY ?? !!process.stdout.isTTY,
      plain: deps.plain ?? false,
      verbose,
      onAbort: () => abortController.abort(),
      createTui: deps.createTui ?? defaultCreateTui,
    }));

  // The renderer may also be the Run's interactive responder (the TUI is). When it is not (plain /
  // non-TTY), wire clear failing responders so an Ask/approval fails with an actionable message
  // instead of the engine's internal headless-suspend error.
  const interactive = renderer as InteractiveRenderer;
  const ask = interactive.ask?.bind(interactive) ?? failingAskResponder();
  const approveFindings =
    interactive.approveFindings?.bind(interactive) ?? failingApproveResponder();

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

  // Production `tml ship` runs in an isolated snapshot workspace. Test seams that inject an Engine
  // keep the old direct cwd path, so unit tests can stay small and avoid creating git fixtures.
  let view = initialView;
  let workspaceToClean: string | undefined;
  let setupJournal: RunJournal | undefined;
  try {
    let runCwd = cwd;
    let config: Config;
    let journal: RunJournal | undefined;

    if (deps.engineFor === undefined) {
      if (deps.journal === false) {
        throw new Error("tml ship: isolated runs require the Run Journal.");
      }
      const sourceConfig = await buildConfig(cwd);
      journal =
        deps.journal ??
        createRunJournal({
          checkoutPath: cwd,
          resume: deps.journalResume ?? "auto",
          ...(deps.runId ? { runId: deps.runId } : {}),
        });
      setupJournal = journal;
      const resumeKey = await currentWorkspaceSourceBranch(cwd);
      const snapshot = await journal.begin({
        pipeline: sourceConfig.pipeline.map((s) => s.name),
        ...(resumeKey !== undefined ? { resumeKey } : {}),
      });
      const workspacePath = snapshot.metadata.workspacePath;
      if (workspacePath === undefined) throw new Error("tml ship: Run Journal has no workspace.");
      const workspaceExists = existsSync(join(workspacePath, ".git"));
      const hasRunProgress =
        snapshot.completedSteps.size > 0 ||
        snapshot.rounds.length > 0 ||
        snapshot.artifacts.size > 0;
      if (!workspaceExists) {
        if (hasRunProgress) {
          throw new Error(
            `tml ship: cannot resume run ${snapshot.metadata.runId}; its workspace is missing. ` +
              "Use `tml ship --fresh` to start a new isolated run.",
          );
        }
        await createIsolatedWorkspace(cwd, workspacePath);
      }
      runCwd = workspacePath;
      workspaceToClean = workspacePath;
      config = await buildConfig(runCwd);
      const names = config.pipeline.map((s) => s.name);
      if (names.join("\0") !== snapshot.metadata.pipeline.join("\0")) {
        throw new Error("tml ship: snapshot pipeline does not match the selected Run Journal.");
      }
    } else {
      journal = deps.journal === false ? undefined : deps.journal;
      config = await buildConfig(cwd);
    }

    const engine = engineFor(config, {
      cwd: runCwd,
      ask,
      approveFindings,
      signal: abortController.signal,
      ...(journal ? { journal } : {}),
    });
    let failed = false;
    let cancelled = false;
    let finished = false;
    // Fold each event into the shared ViewState, then let the renderer draw it.
    for await (const event of engine.run()) {
      view = present(view, event);
      renderer.render(view, event);
      if (event.type === "run:failed") failed = true;
      if (event.type === "run:cancelled") cancelled = true;
      if (event.type === "run:finished") finished = true;
    }
    if (finished && workspaceToClean !== undefined) {
      await removeIsolatedWorkspace(workspaceToClean);
      workspaceToClean = undefined;
    }
    // 130 = the conventional SIGINT exit code; an Abort is not a failure.
    return cancelled ? 130 : failed ? 1 : 0;
  } catch (error) {
    await setupJournal?.finish("failed").catch(() => undefined);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    renderer.close(); // stop the spinner timer / clear the live region / tear down the TUI
    // After the alternate screen is torn down, print a compact scrollback epilogue (TUI only).
    interactive.epilogue?.(view);
  }
}

export interface ShipArgs {
  readonly verbose: boolean;
  readonly plain: boolean;
  readonly journalResume?: RunJournalResumeMode;
  readonly runId?: string;
}

export function parseShipArgs(args: string[]): ShipArgs {
  let verbose = false;
  let plain = false;
  let journalResume: RunJournalResumeMode | undefined;
  let runId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    if (arg === "--plain" || arg === "--no-tui") {
      plain = true;
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
  return {
    verbose,
    plain,
    ...(journalResume ? { journalResume } : {}),
    ...(runId ? { runId } : {}),
  };
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
