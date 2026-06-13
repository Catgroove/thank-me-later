import { describe, expect, test } from "bun:test";

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

async function runCli(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("tml ship", () => {
  test("runs the demo pipeline through the engine and prints its event stream", async () => {
    const { stdout, exitCode } = await runCli("ship");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("run started");
    expect(stdout).toContain("snapshot");
    expect(stdout).toContain("skipped"); // the maybe-skip Step exercised a flow signal
    expect(stdout).toContain("run finished");
  });

  test("unknown command exits non-zero with a hint", async () => {
    const { stderr, exitCode } = await runCli("bogus");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("tml ship");
  });
});
