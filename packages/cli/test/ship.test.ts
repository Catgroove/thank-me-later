import { describe, expect, test } from "bun:test";
import type { Config, Engine, RunEvent, Worktree } from "@tml/core";
import { buildShipConfig } from "../src/config.ts";
import { ship } from "../src/index.ts";

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

async function runCli(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function spyWorktree(): { worktree: Worktree; disposed: () => boolean } {
  let wasDisposed = false;
  return {
    worktree: {
      path: "/tmp/wt",
      dispose() {
        wasDisposed = true;
        return Promise.resolve();
      },
    },
    disposed: () => wasDisposed,
  };
}

function engineYielding(events: RunEvent[]): Engine {
  return {
    async *run(): AsyncGenerator<RunEvent> {
      for (const event of events) yield event;
    },
  };
}

const dummyConfig = { pipeline: [], providers: {} } as unknown as Config;

describe("tml CLI", () => {
  test("unknown command exits non-zero with a hint", async () => {
    const { stderr, exitCode } = await runCli("bogus");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("tml ship");
  });
});

describe("buildShipConfig", () => {
  test("pairs the default pipeline with the GitHub Forge + pi Harness", () => {
    const config = buildShipConfig({ path: "/tmp/wt", dispose: () => Promise.resolve() });

    expect(config.pipeline.map((s) => s.name)).toEqual([
      "branch",
      "format",
      "lint",
      "typecheck",
      "test",
      "review",
      "open-pr",
      "ci-wait",
    ]);
    expect(typeof config.providers.forge.openPullRequest).toBe("function");
    expect(typeof config.providers.agent.run).toBe("function");
  });
});

describe("ship() worktree lifecycle", () => {
  test("runs in the worktree and disposes it on success (exit 0)", async () => {
    const { worktree, disposed } = spyWorktree();
    const lines: string[] = [];

    const code = await ship({
      cwd: "/repo",
      setupWorktree: () => Promise.resolve(worktree),
      buildConfig: () => dummyConfig,
      engineFor: () =>
        engineYielding([{ type: "run:started", pipeline: [] }, { type: "run:finished" }]),
      log: (l) => lines.push(l),
    });

    expect(code).toBe(0);
    expect(disposed()).toBe(true);
    expect(lines).toContain("■ run finished");
  });

  test("returns 1 and still disposes the worktree when the run fails", async () => {
    const { worktree, disposed } = spyWorktree();

    const code = await ship({
      setupWorktree: () => Promise.resolve(worktree),
      buildConfig: () => dummyConfig,
      engineFor: () => engineYielding([{ type: "run:failed", step: "test", error: "boom" }]),
      log: () => {},
    });

    expect(code).toBe(1);
    expect(disposed()).toBe(true);
  });

  test("returns 130 (SIGINT) on cancellation and disposes", async () => {
    const { worktree, disposed } = spyWorktree();

    const code = await ship({
      setupWorktree: () => Promise.resolve(worktree),
      buildConfig: () => dummyConfig,
      engineFor: () => engineYielding([{ type: "run:cancelled" }]),
      log: () => {},
    });

    expect(code).toBe(130);
    expect(disposed()).toBe(true);
  });

  test("disposes the worktree even when engine setup throws", async () => {
    const { worktree, disposed } = spyWorktree();

    const code = await ship({
      setupWorktree: () => Promise.resolve(worktree),
      buildConfig: () => dummyConfig,
      engineFor: () => {
        throw new Error("engine construction failed");
      },
      log: () => {},
    });

    expect(code).toBe(1);
    expect(disposed()).toBe(true);
  });
});
