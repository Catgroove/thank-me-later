import { describe, expect, test } from "bun:test";
import { AbortError, type AgentProgress, type Harness } from "@tml/core";
import { createPiHarness } from "../src/harness.ts";
import type { PiProcess, PiSpawn } from "../src/spawn.ts";
import { LIST_MODELS_LINES, NO_AGENT_END_LINES, NO_TOOLS_LINES, TOOL_LINES } from "./fixtures.ts";

/** A fake seam that replays canned lines then resolves `done`. */
function fakeSpawn(
  lines: readonly string[],
  done: { exitCode?: number; stderr?: string } = {},
): PiSpawn {
  return (): PiProcess => ({
    stdout: (async function* () {
      for (const line of lines) yield line;
    })(),
    done: Promise.resolve({ exitCode: done.exitCode ?? 0, stderr: done.stderr ?? "" }),
    kill() {},
  });
}

const line = (event: unknown): string => JSON.stringify(event);

/** Await a promise expected to reject and return the error (repo pattern, lint-clean). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("createPiHarness — conformance", () => {
  test("returns a value assignable to Harness", () => {
    const harness = createPiHarness("/tmp", { spawn: fakeSpawn(NO_TOOLS_LINES) }) satisfies Harness;
    expect(typeof harness.run).toBe("function");
    expect(typeof harness.listModels).toBe("function");
  });
});

describe("createPiHarness — run", () => {
  test("maps a no-tools stream to one text progress and the accumulated summary", async () => {
    const harness = createPiHarness("/tmp", { spawn: fakeSpawn(NO_TOOLS_LINES) });
    const seen: AgentProgress[] = [];
    const result = await harness.run("say hi", { onProgress: (p) => seen.push(p) });

    expect(seen).toEqual([{ kind: "text", text: "Hi" }]);
    expect(result).toEqual({ ok: true, summary: "Hi" });
  });

  test("fires onProgress in stream order (tool start/end then text) for a tool run", async () => {
    const harness = createPiHarness("/tmp", { spawn: fakeSpawn(TOOL_LINES) });
    const seen: AgentProgress[] = [];
    const result = await harness.run("list files", { onProgress: (p) => seen.push(p) });

    expect(seen).toEqual([
      { kind: "tool", name: "ls", phase: "start" },
      { kind: "tool", name: "ls", phase: "end" },
      { kind: "text", text: "done" },
    ]);
    expect(result.summary).toBe("done");
  });

  test("with a schema, inlines it and returns parsed, valid output", async () => {
    const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const lines = [
      line({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: '```json\n{"ok": true}\n```' },
      }),
      line({ type: "agent_end", messages: [] }),
    ];
    const harness = createPiHarness("/tmp", { spawn: fakeSpawn(lines) });

    const result = await harness.run("review", { schema });
    expect(result.output).toEqual({ ok: true });
  });

  test("with a schema, throws when the reply carries no valid JSON", async () => {
    const schema = { type: "object", required: ["ok"] };
    const lines = [
      line({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "sorry, no json" },
      }),
      line({ type: "agent_end", messages: [] }),
    ];
    const harness = createPiHarness("/tmp", { spawn: fakeSpawn(lines) });
    expect(String(await rejection(harness.run("review", { schema })))).toMatch(
      /no JSON object satisfying required schema fields/,
    );
  });

  test("throws with stderr on a non-zero exit", async () => {
    const harness = createPiHarness("/tmp", {
      spawn: fakeSpawn(NO_TOOLS_LINES, { exitCode: 1, stderr: "kaboom" }),
    });
    expect(String(await rejection(harness.run("x")))).toMatch(/pi failed \(exit 1\): kaboom/);
  });

  test("throws on a truncated stream with no agent_end", async () => {
    const harness = createPiHarness("/tmp", { spawn: fakeSpawn(NO_AGENT_END_LINES) });
    expect(String(await rejection(harness.run("x")))).toMatch(/no agent_end/);
  });

  test("rejects without spawning when the signal is already aborted", async () => {
    let spawned = false;
    const spawn: PiSpawn = () => {
      spawned = true;
      throw new Error("spawned");
    };
    const controller = new AbortController();
    controller.abort();
    const harness = createPiHarness("/tmp", { spawn });

    expect(await rejection(harness.run("long task", { signal: controller.signal }))).toBeInstanceOf(
      AbortError,
    );
    expect(spawned).toBe(false);
  });

  test("aborting mid-stream kills the process and rejects with AbortError", async () => {
    // stdout emits one text line, then blocks until kill() is called.
    const textLine = line({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "working" },
    });
    const abortableSpawn: PiSpawn = () => {
      let onKill: () => void = () => {};
      const killed = new Promise<void>((resolve) => {
        onKill = resolve;
      });
      let resolveDone: (value: { exitCode: number; stderr: string }) => void = () => {};
      const done = new Promise<{ exitCode: number; stderr: string }>((resolve) => {
        resolveDone = resolve;
      });
      return {
        stdout: (async function* () {
          yield textLine;
          await killed;
        })(),
        done,
        kill() {
          onKill();
          resolveDone({ exitCode: 130, stderr: "" });
        },
      };
    };

    const controller = new AbortController();
    const harness = createPiHarness("/tmp", { spawn: abortableSpawn });
    const seen: AgentProgress[] = [];
    const promise = harness.run("long task", {
      signal: controller.signal,
      onProgress: (p) => {
        seen.push(p);
        controller.abort(); // interrupt right after the first progress
      },
    });

    expect(await rejection(promise)).toBeInstanceOf(AbortError);
    expect(seen).toEqual([{ kind: "text", text: "working" }]);
  });
});

describe("createPiHarness — listModels", () => {
  test("passes --list-models and parses the output into ids", async () => {
    let seenArgs: string[] = [];
    const spawn: PiSpawn = (args, opts) => {
      seenArgs = args;
      return fakeSpawn(LIST_MODELS_LINES)(args, opts);
    };
    const harness = createPiHarness("/tmp", { spawn });
    expect(await harness.listModels?.()).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.5",
      "google/gemini-3-pro",
    ]);
    expect(seenArgs).toEqual(["--list-models"]);
  });

  test("throws with stderr on a non-zero exit", async () => {
    const harness = createPiHarness("/tmp", {
      spawn: fakeSpawn([], { exitCode: 1, stderr: "models unavailable" }),
    });
    expect(String(await rejection(harness.listModels?.() ?? Promise.resolve([])))).toMatch(
      /pi --list-models failed \(exit 1\): models unavailable/,
    );
  });
});
