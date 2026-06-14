// Worktree — the disposable `.tml/<id>` git worktree the pipeline runs in (ADR-0010).
// `createWorktree` snapshots the live checkout (committed + staged + unstaged + untracked)
// into a throwaway worktree, so the Run mutates a copy and the user's checkout is left
// untouched. It is a host-level capability wrapped *around* a Run: the host (the CLI) passes
// `path` as the engine `cwd` and to the Providers, so `ctx.git`, the Forge, and the Harness
// all operate in the worktree — the engine knows nothing about worktrees. `dispose()` removes
// the worktree directory only; any branch/commits made in it survive (so the pushed PR holds).

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Worktree {
  /** Absolute path to the worktree; pass as the engine `cwd` and to the Providers. */
  readonly path: string;
  /** Remove the worktree directory (`git worktree remove`); branch + commits survive. */
  dispose(): Promise<void>;
}

/** Run git at `cwd`, optionally feeding `stdin` (used to pipe a diff into `git apply`). */
async function git(cwd: string, args: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

export async function createWorktree(cwd: string): Promise<Worktree> {
  const head = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  const path = join(cwd, ".tml", `ship-${head}`);

  // Capture the dirty state *before* creating the worktree, so the worktree's own files can
  // never leak into the snapshot. `git diff HEAD` covers tracked changes (staged + unstaged,
  // relative to HEAD); untracked-not-ignored files are listed separately and copied.
  const diff = await git(cwd, ["diff", "HEAD", "--binary"]);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // 1. Worktree at the current commit, detached → the committed state.
  await git(cwd, ["worktree", "add", "--detach", path, "HEAD"]);

  // 2. Replay tracked modifications into the worktree.
  if (diff.trim().length > 0) {
    await git(path, ["apply", "--whitespace=nowarn"], diff);
  }

  // 3. Copy untracked files (the diff never carries them).
  for (const file of untracked) {
    const dest = join(path, file);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(cwd, file), dest);
  }

  return {
    path,
    async dispose() {
      await git(cwd, ["worktree", "remove", "--force", path]);
    },
  };
}
