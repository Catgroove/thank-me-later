// Isolated ship worktree. After `tml ship` branches and commits the work in the source checkout, it
// hands that feature branch to a disposable `git worktree` and runs the noisy remainder of the
// pipeline (rebase, checks, review, open-pr, ci-wait) there. A worktree shares the source repo's
// object database and refs, so the branch and its commits are real in the user's repo throughout -
// disposing the worktree removes only its directory, leaving the PR branch intact.

import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnGit } from "./git-spawn.ts";

interface GitRunOptions {
  readonly allowExitCodes?: readonly number[];
}

async function git(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<string> {
  const { exitCode, stdout, stderr } = await spawnGit(cwd, args);
  const allowed = opts.allowExitCodes ?? [0];
  if (!allowed.includes(exitCode)) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** The current branch for branch-scoped resume, or undefined when detached/unreadable. */
export async function currentWorkspaceSourceBranch(
  sourcePath: string,
): Promise<string | undefined> {
  try {
    const branch = (await git(sourcePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return branch.length === 0 || branch === "HEAD" ? undefined : branch;
  } catch {
    return undefined;
  }
}

/** Reject catastrophic paths before any destructive worktree operation. */
function assertSafeWorktreePath(worktreePath: string): string {
  const target = resolve(worktreePath);
  if (target === "/" || target.length < 8) {
    throw new Error(`refusing to operate on unsafe worktree path: ${worktreePath}`);
  }
  return target;
}

/**
 * Add a worktree at `worktreePath` checked out on `branch` (created earlier in the source checkout).
 * The source checkout must have already switched off `branch` - git forbids the same branch being
 * checked out in two worktrees at once. Any stale worktree or leftover directory at the path is
 * cleared first so a re-run starts clean.
 */
export async function createWorktree(
  sourcePath: string,
  branch: string,
  worktreePath: string,
): Promise<void> {
  const source = resolve(sourcePath);
  const worktree = assertSafeWorktreePath(worktreePath);

  // Clear any stale registration/dir from a previous run, then ensure the parent exists.
  await git(source, ["worktree", "remove", "--force", worktree], { allowExitCodes: [0, 1, 128] });
  await git(source, ["worktree", "prune"], { allowExitCodes: [0, 1, 128] });
  await rm(worktree, { recursive: true, force: true });
  await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });

  await git(source, ["worktree", "add", worktree, branch]);
}

/** Remove a disposable worktree directory and deregister it. The branch + its commits survive. */
export async function removeWorktree(sourcePath: string, worktreePath: string): Promise<void> {
  const source = resolve(sourcePath);
  const worktree = assertSafeWorktreePath(worktreePath);
  await git(source, ["worktree", "remove", "--force", worktree], { allowExitCodes: [0, 1, 128] });
  await git(source, ["worktree", "prune"], { allowExitCodes: [0, 1, 128] });
  // A failed `worktree remove` (e.g. the registration was already gone) can leave the directory;
  // sweep it so the next run's `worktree add` is not blocked.
  await rm(worktree, { recursive: true, force: true });
}
