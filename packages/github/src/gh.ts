// The single seam to the outside world: shell out to the `gh` CLI. Everything
// else in this package is pure and tested through an injected `GhRunner`, so this
// is the only code that touches a subprocess (mirrors core's `git(cwd, args)`
// helper). Auth and repo detection are `gh`'s job — we run it in `cwd`.

/** Run `gh` with the given argv (without the leading `gh`) and resolve its stdout. */
export type GhRunner = (args: string[]) => Promise<string>;

/** Spawn a binary, capture stdout, throw on non-zero exit with stderr. */
export async function spawnCapture(argv: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** The real runner: shells `gh` in `cwd`. */
export function defaultRunner(cwd: string): GhRunner {
  return (args) => spawnCapture(["gh", ...args], cwd);
}
