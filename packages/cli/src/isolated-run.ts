import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  createGit,
  createWorktree,
  currentWorkspaceSourceBranch,
  type Engine,
  type EngineOptions,
  type Git,
  isolationBoundaryFor,
  releaseSourceBranchForWorktree,
  removeWorktree,
  type RunEvent,
  type RunJournal,
  type RunJournalSnapshot,
  type SourceBranchRelease,
} from "@tml/core";

/** The result of a whole isolated run, before it is mapped to a process exit code. */
export interface RunOutcome {
  readonly failed: boolean;
  readonly cancelled: boolean;
  readonly finished: boolean;
  /** The Run reached a resumable rest (a ready PR not yet landed); a success-like, re-runnable state. */
  readonly parked: boolean;
}

/** Conventional exit code for a run: 130 (SIGINT) when cancelled, 1 on failure, else 0 (parked too). */
export const outcomeExitCode = (o: RunOutcome): number => (o.cancelled ? 130 : o.failed ? 1 : 0);

/** Outcome of one engine pass; `paused` only matters between the two phases of an isolated run. */
interface PassOutcome {
  failed: boolean;
  cancelled: boolean;
  finished: boolean;
  parked: boolean;
  paused: boolean;
}

/** A phase-2 workspace prepared by the isolation adapter; `finalize` reclaims it. */
export interface IsolatedWorkspace {
  /** Working directory the second phase runs in. */
  readonly path: string;
  /** Tear down the workspace and restore the source checkout. Always called, even on failure. */
  finalize(): Promise<void>;
}

export interface HandoffInput {
  readonly cwd: string;
  readonly journal: RunJournal;
  readonly snapshot: RunJournalSnapshot;
  /** The workspace path the Run Journal reserved for this run. */
  readonly worktreePath: string;
}

/**
 * The seam between an isolated run's deterministic orchestration and the git/worktree mechanism it
 * runs on. `worktreeIsolation` hands the feature branch to a disposable git worktree (production);
 * `inCheckoutIsolation` keeps the whole run in the source checkout (tests, and an in-place mode).
 */
export interface IsolationAdapter {
  /** The resume key for the source checkout (its current branch), or undefined when unknown. */
  sourceResumeKey(cwd: string): Promise<string | undefined>;
  /** Hand the feature branch to a workspace for phase 2, returning it and its finalizer. */
  handoff(input: HandoffInput): Promise<IsolatedWorkspace>;
}

async function finalizeWorktreeHandoff(input: {
  readonly cwd: string;
  readonly git: Git;
  readonly sourceRelease: SourceBranchRelease;
  readonly workspacePath?: string;
}): Promise<void> {
  try {
    if (input.workspacePath !== undefined) await removeWorktree(input.cwd, input.workspacePath);
  } finally {
    if (input.sourceRelease.kind === "detached") {
      await input.git.checkout(input.sourceRelease.restoreBranch);
    }
  }
}

/**
 * Production isolation: the source checkout is on the feature branch with the work committed. Switch
 * it back to the default branch so the worktree can claim the feature branch (git allows a branch in
 * one worktree only), then add the worktree on that branch. `finalize` removes the worktree and
 * restores the source checkout.
 */
export const worktreeIsolation: IsolationAdapter = {
  sourceResumeKey: (cwd) => currentWorkspaceSourceBranch(cwd),
  async handoff({ cwd, journal, snapshot, worktreePath }) {
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
    const sourceRelease = await releaseSourceBranchForWorktree({
      sourcePath: cwd,
      git: sourceGit,
      base,
      currentBranch,
      featureBranch,
    });
    const finalize = (): Promise<void> =>
      finalizeWorktreeHandoff({ cwd, git: sourceGit, sourceRelease, workspacePath: worktreePath });
    try {
      if (!existsSync(join(worktreePath, ".git"))) {
        await createWorktree(cwd, featureBranch, worktreePath);
      }
    } catch (error) {
      // The source branch is already released; restore it before surfacing the original failure.
      await finalize().catch(() => undefined);
      throw error;
    }
    return { path: worktreePath, finalize };
  },
};

/**
 * In-checkout isolation: run both phases in the source checkout with no worktree and no branch
 * gymnastics (the feature branch is already checked out after phase 1). Used by tests to exercise
 * the orchestration without git fixtures, and a valid in-place mode for runs that opt out of a
 * disposable worktree.
 */
export const inCheckoutIsolation: IsolationAdapter = {
  sourceResumeKey: () => Promise.resolve(undefined),
  handoff: ({ cwd }) => Promise.resolve({ path: cwd, finalize: () => Promise.resolve() }),
};

/** Everything an isolated run needs beyond the source `Config`: seams, journal, and the event sink. */
export interface IsolatedRunContext {
  readonly cwd: string;
  /** Build the Config for a directory; phase 2 rebuilds it for the worktree path. */
  readonly buildConfig: (cwd: string) => Config | Promise<Config>;
  readonly engineFor: (config: Config, opts: EngineOptions) => Engine;
  readonly ask: NonNullable<EngineOptions["ask"]>;
  readonly approveFindings: NonNullable<EngineOptions["approveFindings"]>;
  readonly signal: AbortSignal;
  readonly journal: RunJournal;
  readonly isolation: IsolationAdapter;
  /** Fold each non-paused engine event into the host's view + renderer. */
  readonly emit: (event: RunEvent) => void;
}

const toOutcome = (o: PassOutcome): RunOutcome => ({
  failed: o.failed,
  cancelled: o.cancelled,
  finished: o.finished,
  parked: o.parked,
});

/**
 * Drive the two-phase isolated run on a journaled Run. A pipeline with an isolation boundary runs
 * its deterministic prefix (branch/describe/commit-change) in the source checkout, pauses, hands the
 * feature branch to the isolation adapter, then resumes the rest in the workspace - the engine
 * coalesces the phase-1 replay so the Run reads as one continuous stream. A pipeline with no
 * boundary runs in a single pass in the source checkout.
 */
export async function isolatedRun(
  sourceConfig: Config,
  ctx: IsolatedRunContext,
): Promise<RunOutcome> {
  const { cwd, buildConfig, engineFor, ask, approveFindings, signal, journal, isolation, emit } =
    ctx;

  const runPass = async (engine: Engine): Promise<PassOutcome> => {
    const outcome: PassOutcome = {
      failed: false,
      cancelled: false,
      finished: false,
      parked: false,
      paused: false,
    };
    for await (const event of engine.run()) {
      if (event.type === "run:paused") {
        outcome.paused = true;
        continue;
      }
      emit(event);
      if (event.type === "run:failed") outcome.failed = true;
      if (event.type === "run:cancelled") outcome.cancelled = true;
      if (event.type === "run:finished") outcome.finished = true;
      if (event.type === "run:parked") outcome.parked = true;
    }
    return outcome;
  };

  const resumeKey = await isolation.sourceResumeKey(cwd);
  const pipelineNames = sourceConfig.pipeline.map((s) => s.name);
  const snapshot = await journal.begin({
    pipeline: pipelineNames,
    ...(resumeKey !== undefined ? { resumeKey } : {}),
  });

  const boundary = isolationBoundaryFor(sourceConfig.pipeline);
  if (boundary === undefined) {
    const engine = engineFor(sourceConfig, { cwd, ask, approveFindings, signal, journal });
    return toOutcome(await runPass(engine));
  }

  const worktreePath = snapshot.metadata.workspacePath;
  if (worktreePath === undefined) throw new Error("tml ship: Run Journal has no workspace.");
  const boundaryName = boundary.step.name;
  const sourcePhase = new Set(boundary.sourceSteps.map((step) => step.name));

  // Phase 1: branch/describe/commit-change in the source checkout, pausing at the boundary. Skip it
  // when a resumed Run already finished the boundary (the branch + commit are durable in git).
  if (!snapshot.completedSteps.has(boundaryName)) {
    const phase1 = engineFor(sourceConfig, {
      cwd,
      ask,
      approveFindings,
      signal,
      journal,
      stopAfter: boundaryName,
    });
    const outcome = await runPass(phase1);
    if (outcome.finished || outcome.failed || outcome.cancelled || outcome.parked)
      return toOutcome(outcome);
    if (!outcome.paused) throw new Error("tml ship: engine stopped before the isolation handoff.");
  }

  const workspace = await isolation.handoff({ cwd, journal, snapshot, worktreePath });
  try {
    // Phase 2: the rest of the pipeline runs in the workspace, resuming the same journaled Run. The
    // engine coalesces the source-phase replay so the Run reads as one continuous stream.
    const worktreeConfig = await buildConfig(workspace.path);
    if (worktreeConfig.pipeline.map((s) => s.name).join("\0") !== pipelineNames.join("\0")) {
      throw new Error("tml ship: snapshot pipeline does not match the selected Run Journal.");
    }
    const phase2 = engineFor(worktreeConfig, {
      cwd: workspace.path,
      ask,
      approveFindings,
      signal,
      journal,
      coalesceEvents: { suppressRunStarted: true, replaySteps: sourcePhase },
    });
    return toOutcome(await runPass(phase2));
  } finally {
    await workspace.finalize();
  }
}
