import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Engine, RunEvent } from "@tml/core";
import { createPlainRenderer, type Renderer } from "@tml/view";
import { assembleShipConfig } from "../src/config.ts";
import type { Loaded } from "../src/load.ts";
import { ship } from "../src/index.ts";

const tempDirs: string[] = [];
function pluginFile(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tml-ship-"));
  tempDirs.push(dir);
  const path = join(dir, "plugin.ts");
  writeFileSync(path, source);
  return path;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NO_CONFIG: Loaded = { selection: {}, pluginPaths: [] };

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

describe("assembleShipConfig", () => {
  test("zero-config: the default pipeline with the GitHub Forge + pi Harness", async () => {
    const config = await assembleShipConfig("/repo", NO_CONFIG);

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
    expect(config.models).toBeUndefined();
  });

  test("honors tml.json selection: disable drops a step, models flows through", async () => {
    const config = await assembleShipConfig("/repo", {
      selection: { disable: ["typecheck"], models: { review: "opus" } },
      pluginPaths: [],
    });
    expect(config.pipeline.map((s) => s.name)).not.toContain("typecheck");
    expect(config.pipeline.map((s) => s.name)).toContain("lint");
    expect(config.models).toEqual({ review: "opus" });
  });

  test("loads a local plugin by path and applies its pipeline patch", async () => {
    const path = pluginFile(
      `export default (tml) => {
         tml.pipeline.insertAfter("review", tml.defineStep({ name: "deep-review", run: () => Promise.resolve({}) }));
       };`,
    );
    const config = await assembleShipConfig("/repo", { selection: {}, pluginPaths: [path] });
    const names = config.pipeline.map((s) => s.name);
    expect(names).toContain("deep-review");
    expect(names.indexOf("deep-review")).toBe(names.indexOf("review") + 1);
  });

  test("rejects a plugin whose default export is not a function", async () => {
    const path = pluginFile(`export default 42;`);
    expect(assembleShipConfig("/repo", { selection: {}, pluginPaths: [path] })).rejects.toThrow(
      /must .export default. a function/,
    );
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

  test("restores the terminal and exits 130 on SIGINT, then removes its handlers", async () => {
    // A signal terminates the process before the `finally` teardown runs, so `ship()`
    // installs handlers that close the renderer (show cursor / end sync) first. Drive the
    // installed handler directly — stubbing `process.exit` so it doesn't kill the runner.
    let started!: () => void;
    const startedAt = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    let closeCount = 0;
    const renderer: Renderer = {
      render(_view, event) {
        if (event.type === "run:started") started();
      },
      close() {
        closeCount += 1;
      },
    };
    const engine: Engine = {
      async *run(): AsyncGenerator<RunEvent> {
        yield { type: "run:started", pipeline: [] };
        await gate; // hang mid-run until the test releases it
      },
    };

    const realExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = ((code?: number): never => {
      exitCode = code;
      throw new Error("__exit__"); // stand in for the process actually exiting
    }) as typeof process.exit;

    const before = process.listenerCount("SIGINT");
    const run = ship({ buildConfig: () => dummyConfig, engineFor: () => engine, renderer });
    try {
      await startedAt; // handlers are registered before the run loop starts

      expect(process.listenerCount("SIGINT")).toBe(before + 1);
      const onSignal = process.listeners("SIGINT").at(-1) as (signal: string) => void;
      expect(() => onSignal("SIGINT")).toThrow("__exit__");
      expect(closeCount).toBeGreaterThanOrEqual(1); // terminal restored before exit
      expect(exitCode).toBe(130);
    } finally {
      process.exit = realExit;
      release();
      await run;
    }

    expect(process.listenerCount("SIGINT")).toBe(before); // no leaked handlers
  });

  test("exits with the signal code even if terminal teardown throws", async () => {
    let started!: () => void;
    const startedAt = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    let throwOnClose = true;
    const renderer: Renderer = {
      render(_view, event) {
        if (event.type === "run:started") started();
      },
      close() {
        if (throwOnClose) throw new Error("close failed");
      },
    };
    const engine: Engine = {
      async *run(): AsyncGenerator<RunEvent> {
        yield { type: "run:started", pipeline: [] };
        await gate;
      },
    };

    const realExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = ((code?: number): never => {
      exitCode = code;
      throw new Error("__exit__");
    }) as typeof process.exit;

    const before = process.listenerCount("SIGTERM");
    const run = ship({ buildConfig: () => dummyConfig, engineFor: () => engine, renderer });
    try {
      await startedAt;

      const onSignal = process.listeners("SIGTERM").at(-1) as (signal: string) => void;
      expect(() => onSignal("SIGTERM")).toThrow("__exit__");
      expect(exitCode).toBe(143);
    } finally {
      throwOnClose = false;
      process.exit = realExit;
      release();
      await run;
    }

    expect(process.listenerCount("SIGTERM")).toBe(before);
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
