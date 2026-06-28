#!/usr/bin/env bun

import {
  classifyLiveness,
  type Config,
  createEngine,
  createGit,
  type Engine,
  type EngineOptions,
  createRunJournal,
  listRuns,
  runMatchesBranch,
  type RunEvent,
  type RunJournal,
  type RunJournalResumeMode,
} from "@tml/core";
import {
  createTerminalRenderer,
  failingApproveResponder,
  failingAskResponder,
  initialView,
  type InteractiveRenderer,
  openSystemUrl,
  present,
  type Renderer,
} from "@tml/view";
import { agents } from "./agents.ts";
import { assembleShipConfig } from "./config.ts";
import { errorMessage } from "./error.ts";
import { init } from "./init.ts";
import {
  type IsolationAdapter,
  isolatedRun,
  outcomeExitCode,
  worktreeIsolation,
} from "./isolated-run.ts";
import { loadTmlConfig } from "./load.ts";
import { runs, viewRun } from "./runs.ts";
import { update } from "./update.ts";
import { maybeStartCheck, updateNotice } from "./update-check.ts";
import { VERSION } from "./version.ts";

/** Seams, injected by tests; production snapshots the checkout into an isolated run workspace. */
export interface ShipDeps {
  cwd?: string;
  /** Build the Config for `cwd`. Async in production (it imports local plugins). */
  buildConfig?: (cwd: string) => Config | Promise<Config>;
  engineFor?: (config: Config, opts: EngineOptions) => Engine;
  /** Override or disable the local Run Journal. Production creates one per checkout. */
  journal?: RunJournal | false;
  /** The git/worktree mechanism the isolated run executes on. Defaults to a disposable worktree. */
  isolation?: IsolationAdapter;
  /** Journal selection policy when production creates the journal. Defaults to a fresh run. */
  journalResume?: RunJournalResumeMode;
  /** Exact run id for `journalResume: "exact"`, or a stable id for tests. */
  runId?: string;
  /** Seal the full per-step trail instead of the quiet, results-forward default (`--verbose`). */
  verbose?: boolean;
  /** Force the append-only/inline terminal renderer instead of the full-screen TUI (`--plain`). */
  plain?: boolean;
  /** Open the Run's PR in the browser when it finishes or fails; overrides the `tml.json` `openInBrowser` knob. */
  openInBrowser?: boolean;
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
  // `openInBrowser` is a presentation knob read from `tml.json`, not part of the pipeline Config, so
  // the default `buildConfig` captures it off the same load instead of parsing config a second time.
  // An injected `buildConfig` (tests) leaves it false unless overridden via `deps.openInBrowser`.
  let configOpenInBrowser = false;
  let configOpenInBrowserLoaded = false;
  const buildConfig =
    deps.buildConfig ??
    ((dir: string) => {
      const loaded = loadTmlConfig(dir);
      if (!configOpenInBrowserLoaded) {
        configOpenInBrowser = loaded.openInBrowser;
        configOpenInBrowserLoaded = true;
      }
      return assembleShipConfig(dir, loaded);
    });
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
  // non-TTY), wire clear failing responders so an Ask/approval fails with an actionable message.
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

  // `ship` owns the CLI lifecycle (renderer, signals, epilogue); `isolatedRun` owns the two-phase,
  // journaled run and folds each event back through this sink. Engine + isolation seams are injected
  // so tests drive the whole handoff without git fixtures (the in-checkout adapter).
  let view = initialView;
  let setupJournal: RunJournal | undefined;
  let fatalErrorMessage: string | undefined;
  const emit = (event: RunEvent): void => {
    view = present(view, event);
    renderer.render(view, event);
  };

  try {
    if (deps.journal === false) {
      throw new Error("tml ship: isolated runs require the Run Journal.");
    }
    const sourceConfig = await buildConfig(cwd);
    const journal =
      deps.journal ??
      createRunJournal({
        checkoutPath: cwd,
        resume: deps.journalResume ?? "fresh",
        ...(deps.runId ? { runId: deps.runId } : {}),
      });
    setupJournal = journal;
    const outcome = await isolatedRun(sourceConfig, {
      cwd,
      buildConfig,
      engineFor,
      ask,
      approveFindings,
      signal: abortController.signal,
      journal,
      isolation: deps.isolation ?? worktreeIsolation,
      emit,
    });
    return outcomeExitCode(outcome);
  } catch (error) {
    await setupJournal?.finish("failed").catch(() => undefined);
    fatalErrorMessage = errorMessage(error);
    return 1;
  } finally {
    try {
      try {
        await renderer.complete?.(view);
      } finally {
        renderer.close(); // stop the spinner timer / clear the live region / tear down the TUI
      }
    } finally {
      for (const signal of signals) process.off(signal, onSignal);
    }
    // After the alternate screen is torn down, print a compact scrollback epilogue (TUI only).
    interactive.epilogue?.(view);
    // Best-effort: with `openInBrowser` set, do for the user what the TUI `o` key does once the Run
    // has a PR and reached a finished/failed terminal state. Opening here (after teardown) avoids
    // stealing focus from a live TUI; a user-cancelled Run is left alone.
    const openInBrowser = deps.openInBrowser ?? configOpenInBrowser;
    if (
      openInBrowser &&
      view.prUrl !== undefined &&
      (view.status === "finished" || view.status === "failed")
    ) {
      openSystemUrl(view.prUrl);
    }
    if (fatalErrorMessage !== undefined) console.error(fatalErrorMessage);
  }
}

export interface ShipArgs {
  readonly verbose: boolean;
  readonly plain: boolean;
  readonly journalResume?: RunJournalResumeMode;
  readonly runId?: string;
}

type JournalSelection =
  | { readonly mode: "fresh" }
  | { readonly mode: "auto" }
  | { readonly mode: "exact"; readonly runId: string };

export function parseShipArgs(args: string[]): ShipArgs {
  let verbose = false;
  let plain = false;
  let journalSelection: JournalSelection | undefined;
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
      journalSelection = { mode: "fresh" };
      continue;
    }
    if (arg === "--resume") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        journalSelection = { mode: "exact", runId: next };
        i += 1;
      } else {
        journalSelection = { mode: "auto" };
      }
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const exactRunId = arg.slice("--resume=".length);
      if (exactRunId.length === 0) throw new Error("--resume requires a run id");
      journalSelection = { mode: "exact", runId: exactRunId };
      continue;
    }
    throw new Error(`Unknown ship option: ${arg}`);
  }
  return {
    verbose,
    plain,
    ...(journalSelection ? { journalResume: journalSelection.mode } : {}),
    ...(journalSelection?.mode === "exact" ? { runId: journalSelection.runId } : {}),
  };
}

const HELP = `tml - spend time now, thank me later.

Run it when an agent has finished a unit of work; it conducts a code-defined
pipeline that branches, runs checks, reviews, opens a PR, and waits on CI.

Usage:
  tml [options]            Run the pipeline on the current checkout.
  tml runs                 List recent runs for this checkout. (alias: ls)
  tml runs <id>            View a past run, or attach to one still running.
  tml init [options]       Scaffold a starter tml.json at the project root.
  tml update               Update tml to the latest release.
  tml version              Print the installed version.

  tml agents              List available agents and the configured default.

Options:
  -v, --verbose       Seal the full per-step trail instead of the quiet,
                      results-forward default.
      --plain         Force the append-only/inline renderer instead of the
                      full-screen TUI. (alias: --no-tui)
      --fresh         Start a new isolated run, discarding previous journal state
                      (default).
      --resume [id]   Resume the latest compatible run for this branch, or a
                      specific run by exact id. (also --resume=<id>)

Init options:
  -f, --force         Overwrite an existing tml.json.

Update options:
      --check         Report whether a newer release exists without installing.

Global options:
  -h, --help          Show this help.
      --version       Print the installed version. (alias: -V)`;

const isHelp = (arg: string | undefined): boolean => arg === "--help" || arg === "-h";
// `-v` is the verbose pipeline flag, not a version alias: bare `tml` runs the pipeline, so `tml -v`
// means a verbose run. Version is `version` / `--version` / `-V` only.
const isVersion = (arg: string | undefined): boolean =>
  arg === "version" || arg === "--version" || arg === "-V";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (isVersion(command)) {
    console.log(VERSION);
    return 0;
  }
  if (isHelp(command)) {
    console.log(HELP);
    return 0;
  }

  // Fire the background update check (best-effort, non-blocking); it caches its result for the
  // notice printed after the command completes.
  void maybeStartCheck();

  const code = await dispatch(command, rest, argv);

  // Print the cached "new version" notice after the command — and after any TUI teardown — so it
  // never corrupts the alternate screen or a piped stdout. `update` reports versions itself.
  if (command !== "update") {
    const notice = updateNotice();
    if (notice !== null) console.error(notice);
  }
  return code;
}

async function dispatch(
  command: string | undefined,
  rest: string[],
  argv: string[],
): Promise<number> {
  if (command === "init") {
    if (rest.some(isHelp)) {
      console.log(HELP);
      return 0;
    }
    const force = rest.includes("--force") || rest.includes("-f");
    return init({ force });
  }
  if (command === "update") {
    if (rest.some(isHelp)) {
      console.log(HELP);
      return 0;
    }
    return update({ check: rest.includes("--check") });
  }
  if (command === "agents") {
    if (rest.some(isHelp)) {
      console.log(HELP);
      return 0;
    }
    return agents();
  }
  if (command === "runs" || command === "ls") {
    if (rest.some(isHelp)) {
      console.log(HELP);
      return 0;
    }
    const id = rest.find((arg) => !arg.startsWith("-"));
    if (id !== undefined) return viewRun({ runId: id });
    // A TTY opens the interactive picker; piped output prints the plain table.
    if (process.stdout.isTTY) return pickRun();
    return runs();
  }
  // Running the pipeline is the default command: `tml [options]`. `ship` remains accepted as an
  // explicit alias so existing invocations keep working, but it is no longer required or advertised.
  const shipArgv = command === "ship" ? rest : argv;
  if (shipArgv.some(isHelp)) {
    console.log(HELP);
    return 0;
  }
  let args: ShipArgs;
  try {
    args = parseShipArgs(shipArgv);
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
  // Bare `tml` on a TTY consults run history first: if an unfinished run for this branch exists, the
  // gate offers resume/attach/list before starting fresh. An explicit --fresh/--resume, --plain, or
  // a non-TTY skips it and runs straight through (scripts and CI are unaffected).
  if (shouldGate(args, !!process.stdout.isTTY)) return gateAndRun(args);
  return ship(args);
}

/** Whether bare `tml` should consult the startup gate: an interactive TTY with no explicit selection. */
export function shouldGate(args: ShipArgs, isTTY: boolean): boolean {
  return isTTY && !args.plain && args.journalResume === undefined;
}

/**
 * Consult run history for the current branch and act on the user's choice. With no unfinished run for
 * the branch, it starts fresh exactly as before; otherwise it shows the gate and maps the decision
 * onto resume, the viewer (attach), the picker (list all), a fresh run, or quitting.
 */
async function gateAndRun(args: ShipArgs): Promise<number> {
  const cwd = process.cwd();
  const branch = await currentBranchOrUndefined(cwd);
  const all = await listRuns({ checkoutPath: cwd });
  // The newest unfinished run for this branch is the candidate; listRuns is already newest-first.
  const candidate = all.find((run) => run.status !== "finished" && runMatchesBranch(run, branch));
  if (candidate === undefined) return ship(args);

  const live = classifyLiveness(candidate, { now: Date.now() }) !== "orphaned";
  const { runStartupGate } = await import("@tml/view/tui");
  const decision = await runStartupGate({ run: candidate, live });
  switch (decision) {
    case "resume":
      return ship({ ...args, journalResume: "exact", runId: candidate.runId });
    case "attach":
      return viewRun({ runId: candidate.runId });
    case "list":
      return pickRun();
    case "fresh":
      return ship({ ...args, journalResume: "fresh" });
    case "quit":
      return 0;
  }
}

/** The current git branch of a checkout, or undefined if HEAD is detached/unreadable. */
async function currentBranchOrUndefined(cwd: string): Promise<string | undefined> {
  try {
    const branch = await createGit(cwd).currentBranch();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open the interactive Run picker for the current checkout and act on the choice: resume re-enters
 * the engine (the journal surfaces a since-changed Pipeline as a clear error), view/attach open the
 * read-only viewer. The OpenTUI picker is lazy-imported so non-TTY paths never load it.
 */
async function pickRun(): Promise<number> {
  const cwd = process.cwd();
  const all = await listRuns({ checkoutPath: cwd });
  if (all.length === 0) {
    console.log("No runs recorded for this checkout yet.");
    return 0;
  }
  const { runPicker } = await import("@tml/view/tui");
  const outcome = await runPicker(all);
  if (outcome.kind === "quit") return 0;
  if (outcome.action === "resume") {
    return ship({ journalResume: "exact", runId: outcome.run.runId });
  }
  return viewRun({ runId: outcome.run.runId });
}

// Only run the CLI when invoked directly — importing this module (e.g. from tests) must not
// trigger the command dispatch + process.exit.
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
