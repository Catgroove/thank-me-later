// The one place core shells out to the system `git`. Both the Git Provider and the workspace
// snapshotter run through this: it captures stdout/stderr/exit code and never throws on a non-zero
// exit, leaving each caller to decide which codes are a result versus an error.

export interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `git` in `cwd`, capturing the exit code instead of throwing. */
export async function spawnGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
