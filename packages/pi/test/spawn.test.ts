import { describe, expect, test } from "bun:test";
import { linesFrom, spawnCommand } from "../src/spawn.ts";

/** A ReadableStream that emits the given byte chunks, so line-splitting is testable. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

describe("linesFrom", () => {
  test("splits LF-delimited lines across chunk boundaries", async () => {
    // A line is split across two chunks ("a" + "b\n"); proves buffering works.
    expect(await collect(linesFrom(streamOf(["a", "b\n", "c\nd\n"])))).toEqual(["ab", "c", "d"]);
  });

  test("emits an unterminated trailing line", async () => {
    expect(await collect(linesFrom(streamOf(["one\ntwo"])))).toEqual(["one", "two"]);
  });

  test("yields nothing for an empty stream", async () => {
    expect(await collect(linesFrom(streamOf([])))).toEqual([]);
  });
});

describe("spawnCommand (Bun.spawn wiring, hermetic)", () => {
  test("streams stdout lines and resolves done with exit code 0", async () => {
    const proc = spawnCommand(["printf", "alpha\\nbeta\\n"], { cwd: "/tmp" });
    const lines = await collect(proc.stdout);
    const { exitCode } = await proc.done;
    expect(lines).toEqual(["alpha", "beta"]);
    expect(exitCode).toBe(0);
  });

  test("done reports a non-zero exit code and stderr", async () => {
    // `ls` of a missing path exits non-zero and writes to stderr.
    const proc = spawnCommand(["ls", "/no/such/path/xyz"], { cwd: "/tmp" });
    await collect(proc.stdout);
    const { exitCode, stderr } = await proc.done;
    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
