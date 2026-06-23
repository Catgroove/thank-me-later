#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  createEngine,
  createGit,
  type Engine,
  type EngineOptions,
  createRunJournal,
  createWorktree,
  currentWorkspaceSourceBranch,
  isolationBoundaryFor,
  removeWorktree,
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
import { errorMessage } from "./error.ts";
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

  // Production `tml ship` runs the early, deterministic Steps (branch/describe/commit-change) in the
  // user's checkout, then hands the feature branch to a disposable worktree for the rest. Test seams
  // that inject an Engine keep the direct single-pass cwd path, so unit tests avoid git fixtures.
  let view = initialView;
  let workspaceToClean: string | undefined;
  let setupJournal: RunJournal | undefined;

  // Outcome of one engine pass. Two passes (source phase, worktree phase) fold into the same `view`
  // and the same journaled Run; the engine coalesces phase-2 replay-only events before they reach
  // either this live stream or the durable journal.
  interface PassOutcome {
    failed: boolean;
    cancelled: boolean;
    finished: boolean;
    paused: boolean;
  }
  const runPass = async (engine: Engine): Promise<PassOutcome> => {
    const outcome: PassOutcome = {
      failed: false,
      cancelled: false,
      finished: false,
      paused: false,
    };
    for await (const event of engine.run()) {
      if (event.type === "run:paused") {
        outcome.paused = true;
        continue;
      }
      view = present(view, event);
      renderer.render(view, event);
      if (event.type === "run:failed") outcome.failed = true;
      if (event.type === "run:cancelled") outcome.cancelled = true;
      if (event.type === "run:finished") outcome.finished = true;
    }
    return outcome;
  };
  const exitCode = (o: PassOutcome): number => (o.cancelled ? 130 : o.failed ? 1 : 0);

  try {
    // Test seam: a single engine pass directly in the checkout.
    if (deps.engineFor !== undefined) {
      const journal = deps.journal === false ? undefined : deps.journal;
      const config = await buildConfig(cwd);
      const engine = engineFor(config, {
        cwd,
        ask,
        approveFindings,
        signal: abortController.signal,
        ...(journal ? { journal } : {}),
      });
      return exitCode(await runPass(engine));
    }

    if (deps.journal === false) {
      throw new Error("tml ship: isolated runs require the Run Journal.");
    }
    const sourceConfig = await buildConfig(cwd);
    const journal =
      deps.journal ??
      createRunJournal({
        checkoutPath: cwd,
        resume: deps.journalResume ?? "auto",
        ...(deps.runId ? { runId: deps.runId } : {}),
      });
    setupJournal = journal;
    const resumeKey = await currentWorkspaceSourceBranch(cwd);
    const pipelineNames = sourceConfig.pipeline.map((s) => s.name);
    const snapshot = await journal.begin({
      pipeline: pipelineNames,
      ...(resumeKey !== undefined ? { resumeKey } : {}),
    });
    const worktreePath = snapshot.metadata.workspacePath;
    if (worktreePath === undefined) throw new Error("tml ship: Run Journal has no workspace.");

    const boundary = isolationBoundaryFor(sourceConfig.pipeline);
    if (boundary === undefined) {
      const engine = engineFor(sourceConfig, {
        cwd,
        ask,
        approveFindings,
        signal: abortController.signal,
        journal,
      });
      return exitCode(await runPass(engine));
    }
    const boundaryName = boundary.step.name;
    const sourcePhase = new Set(boundary.sourceSteps.map((step) => step.name));

    // Phase 1: branch/describe/commit-change in the source checkout, pausing at the boundary. Skip
    // it when a resumed Run already finished the boundary (the branch + commit are durable in git).
    if (!snapshot.completedSteps.has(boundaryName)) {
      const phase1 = engineFor(sourceConfig, {
        cwd,
        ask,
        approveFindings,
        signal: abortController.signal,
        journal,
        stopAfter: boundaryName,
      });
      const outcome = await runPass(phase1);
      if (outcome.finished || outcome.failed || outcome.cancelled) return exitCode(outcome);
      if (!outcome.paused)
        throw new Error("tml ship: engine stopped before the isolation handoff.");
    }

    // Handoff: the source checkout is on the feature branch with the work committed. Switch it back
    // to the default branch so the worktree can claim the feature branch (git allows a branch in one
    // worktree only), then add the worktree on that branch.
    const sourceGit = createGit(cwd);
    const base = await sourceGit.defaultBranch();
    const currentBranch = await sourceGit.currentBranch();
    const featureBranch =
      snapshot.metadata.worktreeHandoff?.workspaceBranch ??
      snapshot.metadata.workspaceBranch ??
      currentBranch;
    if (featureBranch === base || featureBranch === "HEAD") {
      throw new Error("tml ship: could not determine the feature branch to isolate.");
    }
    await journal.recordWorktreeHandoff({ sourceResumeKey: base, workspaceBranch: featureBranch });
    if (currentBranch === featureBranch) await sourceGit.checkout(base);
    if (!existsSync(join(worktreePath, ".git"))) {
      await createWorktree(cwd, featureBranch, worktreePath);
    }
    workspaceToClean = worktreePath;

    // Phase 2: the rest of the pipeline runs in the worktree, resuming the same journaled Run. The
    // engine coalesces the source-phase replay so the Run reads as one continuous stream.
    const worktreeConfig = await buildConfig(worktreePath);
    if (worktreeConfig.pipeline.map((s) => s.name).join("\0") !== pipelineNames.join("\0")) {
      throw new Error("tml ship: snapshot pipeline does not match the selected Run Journal.");
    }
    const phase2 = engineFor(worktreeConfig, {
      cwd: worktreePath,
      ask,
      approveFindings,
      signal: abortController.signal,
      journal,
      coalesceEvents: { suppressRunStarted: true, replaySteps: sourcePhase },
    });
    const outcome = await runPass(phase2);
    if (outcome.finished && workspaceToClean !== undefined) {
      await removeWorktree(cwd, workspaceToClean);
      workspaceToClean = undefined;
    }
    return exitCode(outcome);
  } catch (error) {
    await setupJournal?.finish("failed").catch(() => undefined);
    console.error(errorMessage(error));
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

const HELP = `tml - spend time now, thank me later.

Run it when an agent has finished a unit of work; it conducts a code-defined
pipeline that branches, runs checks, reviews, opens a PR, and waits on CI.

Usage:
  tml <command> [options]

Commands:
  ship    Run the pipeline on the current checkout.
  init    Scaffold a starter tml.json at the project root.

Ship options:
  -v, --verbose       Seal the full per-step trail instead of the quiet,
                      results-forward default.
      --plain         Force the append-only/inline renderer instead of the
                      full-screen TUI. (alias: --no-tui)
      --fresh         Start a new isolated run, discarding previous journal state.
      --resume <id>   Resume a specific run by exact run id. (also --resume=<id>)

Init options:
  -f, --force         Overwrite an existing tml.json.

Global options:
  -h, --help          Show this help.`;

const isHelp = (arg: string | undefined): boolean => arg === "--help" || arg === "-h";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || isHelp(command)) {
    console.log(HELP);
    return 0;
  }
  if (command === "ship") {
    if (rest.some(isHelp)) {
      console.log(HELP);
      return 0;
    }
    let args: ShipArgs;
    try {
      args = parseShipArgs(rest);
    } catch (error) {
      console.error(errorMessage(error));
      return 1;
    }
    return ship(args);
  }
  if (command === "init") {
    if (rest.some(isHelp)) {
      console.log(HELP);
      return 0;
    }
    const force = rest.includes("--force") || rest.includes("-f");
    return init({ force });
  }
  console.error(`Unknown command: ${command}. Try: tml ship | tml init | tml --help`);
  return 1;
}

// Only run the CLI when invoked directly — importing this module (e.g. from tests) must not
// trigger the command dispatch + process.exit.
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
