// The one impurity in @tml/pi: spawning `pi` and streaming its stdout (the
// streaming analogue of @tml/github's buffered `GhRunner`). `PiProcess` exposes
// stdout as it arrives — `AsyncIterable<string>` of JSONL lines — plus a `done`
// promise and `kill()` for Abort. The harness touches the outside world only
// through the injectable `PiSpawn` seam; tests pass a fake. (Spec 0005.)

export interface PiProcess {
  /** One JSONL event per yielded line, as pi emits it. */
  readonly stdout: AsyncIterable<string>;
  /** Resolves when the process exits, with its code and captured stderr. */
  readonly done: Promise<{ exitCode: number; stderr: string }>;
  /** Terminate the process (wired to the run's AbortSignal). */
  kill(): void;
}

export type PiSpawn = (args: string[], opts: { cwd: string }) => PiProcess;

/** Resolve an executable to its absolute path, or null when absent. Mirrors `Bun.which`. */
export type PiWhich = (command: string) => string | null;

/** Default seam: `pi <args>` via `Bun.spawn`, run in `cwd` so pi sees the repo. */
export const defaultSpawn: PiSpawn = (args, opts) => spawnCommand(["pi", ...args], opts);

/** Default seam: resolve `pi` on PATH via `Bun.which`. Tests inject a fake. */
export const defaultWhich: PiWhich = (command) => Bun.which(command);

/**
 * Spawn an arbitrary command and adapt it to {@link PiProcess}. Factored out of
 * `defaultSpawn` so the Bun.spawn wiring is exercisable with a trivial command in
 * tests (no `pi`, no creds). stderr is drained concurrently to avoid a pipe-full
 * deadlock on a process that never exits until its stderr is read.
 */
export function spawnCommand(command: string[], opts: { cwd: string }): PiProcess {
  const proc = Bun.spawn(command, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const stderrText = new Response(proc.stderr).text();
  const done = (async () => {
    const exitCode = await proc.exited;
    return { exitCode, stderr: await stderrText };
  })();
  return {
    stdout: linesFrom(proc.stdout),
    done,
    kill: () => proc.kill(),
  };
}

/** Split a byte stream into lines (LF-delimited), emitting any unterminated tail. */
export async function* linesFrom(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") yield buffer;
}
