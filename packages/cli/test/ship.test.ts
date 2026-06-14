import { describe, expect, test } from "bun:test";
import type { Config, Engine, RunEvent } from "@tml/core";
import { createPlainRenderer } from "@tml/view";
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
  test("pairs the default pipeline (ai branch mode) with the GitHub Forge + pi Harness", () => {
    const config = buildShipConfig("/repo");

    expect(config.pipeline.map((s) => s.name)).toEqual([
      "branch",
      "describe",
      "commit-change",
      "format",
      "lint",
      "typecheck",
      "test",
      "commit(format+lint+typecheck+test)",
      "review",
      "commit(review)",
      "open-pr",
      "ci-wait",
    ]);
    expect(typeof config.providers.forge.openPullRequest).toBe("function");
    expect(typeof config.providers.agent.run).toBe("function");
  });
});

describe("ship() run lifecycle", () => {
  test("runs in the checkout and returns 0 on success", async () => {
    const lines: string[] = [];

    const code = await ship({
      cwd: "/repo",
      buildConfig: () => dummyConfig,
      engineFor: () =>
        engineYielding([{ type: "run:started", pipeline: [] }, { type: "run:finished" }]),
      renderer: createPlainRenderer((l) => lines.push(l)),
    });

    expect(code).toBe(0);
    expect(lines).toContain("■ run finished");
  });

  test("returns 1 when the run fails", async () => {
    const code = await ship({
      buildConfig: () => dummyConfig,
      engineFor: () => engineYielding([{ type: "run:failed", step: "test", error: "boom" }]),
      renderer: createPlainRenderer(() => {}),
    });

    expect(code).toBe(1);
  });

  test("returns 130 (SIGINT) on cancellation", async () => {
    const code = await ship({
      buildConfig: () => dummyConfig,
      engineFor: () => engineYielding([{ type: "run:cancelled" }]),
      renderer: createPlainRenderer(() => {}),
    });

    expect(code).toBe(130);
  });

  test("returns 1 when engine setup throws", async () => {
    const code = await ship({
      buildConfig: () => dummyConfig,
      engineFor: () => {
        throw new Error("engine construction failed");
      },
      renderer: createPlainRenderer(() => {}),
    });

    expect(code).toBe(1);
  });
});
