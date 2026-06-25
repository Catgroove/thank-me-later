// Git — the local VCS Provider. One of three distinct, typed Provider
// interfaces, deliberately not collapsed into a generic Provider.
//
// `createGit(cwd)` is the real implementation: it shells out to the system `git`
// against a caller-supplied repo directory. Production binds it to the live checkout;
// tests pass a throwaway temp repo.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnGit } from "../git-spawn.ts";

export interface CommitResult {
  readonly sha: string;
}

export interface GitStatus {
  readonly branch: string;
  readonly staged: string[];
  readonly unstaged: string[];
}

export interface GitDiffScope {
  readonly base: string;
  readonly ref: string;
  readonly committedBranchDiffCommand: string;
  readonly trackedWorktreeDiffCommand: string;
  readonly untrackedFilesListCommand: string;
  readonly untrackedFileDiffCommand: string;
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
  checkoutDetached(ref?: string): Promise<void>;
  stageAll(): Promise<void>;
  commit(message: string): Promise<CommitResult>;
  status(): Promise<GitStatus>;
  /** Git diff against `base`, including committed, tracked worktree, and untracked changes. */
  diffAgainst(base: string): Promise<string>;
  diffAgainstScope(base: string): Promise<GitDiffScope>;
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

async function git(cwd: string, args: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await spawnGit(cwd, args);
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

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await spawnGit(cwd, ["rev-parse", "--verify", "--quiet", ref])).exitCode === 0;
}

async function comparisonRef(cwd: string, base: string): Promise<string> {
  return (await refExists(cwd, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

async function untrackedDiff(cwd: string): Promise<string> {
  const out = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const files = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const diffs: string[] = [];
  for (const file of files) {
    const result = await spawnGit(cwd, ["diff", "--no-index", "--", "/dev/null", file]);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`git diff --no-index /dev/null ${file} failed: ${result.stderr.trim()}`);
    }
    if (result.stdout.trim().length > 0) diffs.push(result.stdout.trim());
  }
  return diffs.join("\n\n");
}

function diffScope(base: string, ref: string): GitDiffScope {
  return {
    base,
    ref,
    committedBranchDiffCommand: `git diff --find-renames ${ref}...HEAD --`,
    trackedWorktreeDiffCommand: "git diff --find-renames HEAD --",
    untrackedFilesListCommand: "git ls-files --others --exclude-standard",
    untrackedFileDiffCommand: "git diff --no-index -- /dev/null <path>",
  };
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
      const { exitCode, stderr } = await spawnGit(cwd, [
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
      const { exitCode, stderr } = await spawnGit(cwd, ["rebase", onto]);
      if (exitCode === 0) return { status: "clean" };

      const files = await conflictedFiles(cwd);
      if (files.length > 0) return { status: "conflict", files };

      // Failed for some other reason (not conflicts): don't leave a half-rebase behind.
      await spawnGit(cwd, ["rebase", "--abort"]);
      throw new Error(`git rebase ${onto} failed (exit ${exitCode}): ${stderr.trim()}`);
    },

    async rebaseAbort() {
      await git(cwd, ["rebase", "--abort"]);
    },

    async rebaseInProgress() {
      // `git rev-parse --git-path` resolves these for plain repos and worktrees alike; the state
      // dir's presence is what marks a rebase as still underway.
      for (const dir of ["rebase-merge", "rebase-apply"]) {
        const { exitCode, stdout } = await spawnGit(cwd, ["rev-parse", "--git-path", dir]);
        if (exitCode !== 0) continue;
        const path = stdout.trim();
        if (path.length === 0) continue;
        if (existsSync(isAbsolute(path) ? path : join(cwd, path))) return true;
      }
      return false;
    },

    async createBranch(name, opts) {
      // `--no-track` keeps the new branch from adopting the start point's upstream (e.g. we don't
      // want a branch cut off `origin/main` to track `origin/main`); a later push sets upstream.
      const startPoint = opts?.from ? ["--no-track", opts.from] : [];
      await git(cwd, ["checkout", "-b", name, ...startPoint]);
    },

    async checkout(name) {
      await git(cwd, ["checkout", name]);
    },

    async checkoutDetached(ref) {
      await git(cwd, ["checkout", "--detach", ...(ref ? [ref] : [])]);
    },

    async stageAll() {
      await git(cwd, ["add", "-A"]);
    },

    async commit(message) {
      await git(cwd, ["commit", "-m", message]);
      return { sha: (await git(cwd, ["rev-parse", "HEAD"])).trim() };
    },

    async status() {
      const out = await git(cwd, ["status", "--porcelain=v1", "-z"]);
      const staged: string[] = [];
      const unstaged: string[] = [];
      const entries = out.split("\0").filter((entry) => entry.length > 0);
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (entry === undefined || entry.length < 3) continue;
        const index = entry[0];
        const worktree = entry[1];
        const file = entry.slice(3);
        // Untracked files report as "??" — count them as unstaged (new work).
        if (index !== " " && index !== "?") staged.push(file);
        if (worktree !== " ") unstaged.push(file);
        // Renames and copies include the source path as the next NUL-separated field.
        if (index === "R" || index === "C") i += 1;
      }
      return { branch: await branch(), staged, unstaged };
    },

    async diffAgainst(base) {
      const ref = await comparisonRef(cwd, base);
      const diffs = [
        await git(cwd, ["diff", "--find-renames", `${ref}...HEAD`, "--"]),
        await git(cwd, ["diff", "--find-renames", "HEAD", "--"]),
        await untrackedDiff(cwd),
      ]
        .map((diff) => diff.trim())
        .filter((diff) => diff.length > 0);
      return diffs.join("\n\n");
    },

    async diffAgainstScope(base) {
      return diffScope(base, await comparisonRef(cwd, base));
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
