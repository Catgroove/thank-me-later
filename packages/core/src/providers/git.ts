// Git — the local VCS Provider. One of three distinct, typed Provider
// interfaces, deliberately not collapsed into a generic Provider.
//
// `createGit(cwd)` is the real implementation: it shells out to the system `git`
// against a caller-supplied repo directory. Production binds it to the live checkout;
// tests pass a throwaway temp repo.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface CommitResult {
  readonly sha: string;
}

export interface GitStatus {
  readonly branch: string;
  readonly staged: string[];
  readonly unstaged: string[];
}

/**
 * The outcome of a `rebase`. `clean` — it replayed (or fast-forwarded) without stopping. `conflict`
 * — it stopped on merge conflicts and is *left in progress*: the caller resolves it (e.g. hands the
 * conflicted `files` to the agent to `git add` + `git rebase --continue`) or `rebaseAbort`s it.
 */
export type RebaseResult =
  | { readonly status: "clean" }
  | { readonly status: "conflict"; readonly files: readonly string[] };

export interface Git {
  currentBranch(): Promise<string>;
  /** The repo's default branch (the PR base) — resolved from `origin/HEAD`. */
  defaultBranch(): Promise<string>;
  /** The abbreviated SHA of `ref` (defaults to the current `HEAD`, for deriving branch names). */
  headSha(ref?: string): Promise<string>;
  /** Fetch `branch` from `origin`, updating its remote-tracking ref. */
  fetch(branch: string): Promise<void>;
  /** Whether `ancestor` is an ancestor of (or equal to) `ref` — i.e. `ref` already contains it. */
  isAncestor(ancestor: string, ref: string): Promise<boolean>;
  /**
   * Rebase the current branch onto `onto`. Returns `clean` when it completes (replay or
   * fast-forward), or `conflict` (leaving the rebase in progress) when it stops on merge conflicts.
   * A non-conflict failure aborts the rebase and throws.
   */
  rebase(onto: string): Promise<RebaseResult>;
  /** Abort an in-progress rebase, restoring the branch to its pre-rebase state. */
  rebaseAbort(): Promise<void>;
  /** Whether a rebase is currently in progress (e.g. left mid-conflict). */
  rebaseInProgress(): Promise<boolean>;
  /**
   * Create and check out a new branch. Without `from`, it branches off the current `HEAD`;
   * with `from` (e.g. `origin/main`), it branches off that start point without inheriting its
   * upstream. Either way the uncommitted work is carried onto the new branch.
   */
  createBranch(name: string, opts?: { from?: string }): Promise<void>;
  checkout(name: string): Promise<void>;
  stageAll(): Promise<void>;
  commit(message: string): Promise<CommitResult>;
  status(): Promise<GitStatus>;
  /** Discard all uncommitted changes — tracked and untracked — returning the worktree to `HEAD`. */
  discardChanges(): Promise<void>;
  /**
   * Push `branch` to `origin`, setting upstream tracking (the branch tml ships under). With
   * `force`, uses `--force-with-lease --force-if-includes`: required after a rebase rewrites
   * history, and a safe no-op fast-forward otherwise — it refuses (rather than clobbers) if the
   * remote moved under us.
   */
  push(opts: { branch: string; force?: boolean }): Promise<void>;
}

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run git, capturing the exit code instead of throwing — for commands whose failure is a result. */
async function tryGit(cwd: string, args: string[]): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await tryGit(cwd, args);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** The unmerged (conflicted) paths in the worktree — the files a stopped rebase left for us. */
async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function createGit(cwd: string): Git {
  const branch = async () => (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  return {
    currentBranch: branch,

    async defaultBranch() {
      try {
        // `origin/HEAD` records the remote's default branch as `origin/<name>`.
        const ref = (
          await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        ).trim();
        return ref.replace(/^origin\//, "");
      } catch {
        // No remote / `origin/HEAD` unset: fall back to a conventional default.
        for (const candidate of ["main", "master"]) {
          try {
            await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
            return candidate;
          } catch {
            // not present — try the next candidate
          }
        }
        return "main";
      }
    },

    async headSha(ref = "HEAD") {
      return (await git(cwd, ["rev-parse", "--short", ref])).trim();
    },

    async fetch(branch) {
      await git(cwd, ["fetch", "origin", `+${branch}:refs/remotes/origin/${branch}`]);
    },

    async isAncestor(ancestor, ref) {
      // `--is-ancestor` exits 0 (true) / 1 (false); any other code is a real error.
      const { exitCode, stderr } = await tryGit(cwd, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        ref,
      ]);
      if (exitCode === 0) return true;
      if (exitCode === 1) return false;
      throw new Error(`git merge-base --is-ancestor ${ancestor} ${ref} failed: ${stderr.trim()}`);
    },

    async rebase(onto) {
      const { exitCode, stderr } = await tryGit(cwd, ["rebase", onto]);
      if (exitCode === 0) return { status: "clean" };

      const files = await conflictedFiles(cwd);
      if (files.length > 0) return { status: "conflict", files };

      // Failed for some other reason (not conflicts): don't leave a half-rebase behind.
      await tryGit(cwd, ["rebase", "--abort"]);
      throw new Error(`git rebase ${onto} failed (exit ${exitCode}): ${stderr.trim()}`);
    },

    async rebaseAbort() {
      await git(cwd, ["rebase", "--abort"]);
    },

    async rebaseInProgress() {
      // `git rev-parse --git-path` resolves these for plain repos and worktrees alike; the state
      // dir's presence is what marks a rebase as still underway.
      for (const dir of ["rebase-merge", "rebase-apply"]) {
        const { exitCode, stdout } = await tryGit(cwd, ["rev-parse", "--git-path", dir]);
        if (exitCode !== 0) continue;
        const path = stdout.trim();
        if (path.length === 0) continue;
        if (existsSync(isAbsolute(path) ? path : join(cwd, path))) return true;
      }
      return false;
    },

    async createBranch(name, opts) {
      // `--no-track` keeps the new branch from adopting the start point's upstream (e.g. we don't
      // want a branch cut off `origin/main` to track `origin/main`); `open-pr` sets the upstream.
      const startPoint = opts?.from ? ["--no-track", opts.from] : [];
      await git(cwd, ["checkout", "-b", name, ...startPoint]);
    },

    async checkout(name) {
      await git(cwd, ["checkout", name]);
    },

    async stageAll() {
      await git(cwd, ["add", "-A"]);
    },

    async commit(message) {
      await git(cwd, ["commit", "-m", message]);
      return { sha: (await git(cwd, ["rev-parse", "HEAD"])).trim() };
    },

    async status() {
      const out = await git(cwd, ["status", "--porcelain"]);
      const staged: string[] = [];
      const unstaged: string[] = [];
      for (const line of out.split("\n")) {
        if (line.length === 0) continue;
        const index = line[0];
        const worktree = line[1];
        const file = line.slice(3);
        // Untracked files report as "??" — count them as unstaged (new work).
        if (index !== " " && index !== "?") staged.push(file);
        if (worktree !== " ") unstaged.push(file);
      }
      return { branch: await branch(), staged, unstaged };
    },

    async discardChanges() {
      // Reset tracked files (staged + worktree) to HEAD, then sweep untracked files and dirs.
      await git(cwd, ["reset", "--hard", "HEAD"]);
      await git(cwd, ["clean", "-fd"]);
    },

    async push(opts) {
      const force = opts.force ? ["--force-with-lease", "--force-if-includes"] : [];
      await git(cwd, ["push", ...force, "--set-upstream", "origin", opts.branch]);
    },
  };
}
