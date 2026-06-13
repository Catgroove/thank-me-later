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
  test("prints 'Hello World' and exits 0", async () => {
    const { stdout, exitCode } = await runCli("ship");
    expect(stdout.trim()).toBe("Hello World");
    expect(exitCode).toBe(0);
  });

  test("unknown command exits non-zero with a hint", async () => {
    const { stderr, exitCode } = await runCli("bogus");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("tml ship");
  });
});
