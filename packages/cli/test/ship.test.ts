import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeFinding,
  type Config,
  type Engine,
  type EngineOptions,
  type RunEvent,
  type RunEventInput,
} from "@tml/core";
import { createTerminalRenderer, type InteractiveRenderer, type Renderer } from "@tml/view";
import { assembleShipConfig } from "../src/config.ts";
import type { Loaded } from "../src/load.ts";
import { parseShipArgs, ship } from "../src/index.ts";

/** A plain (append-only) renderer for tests; forwards each emitted line to `onLine`. */
function plainRenderer(onLine: (line: string) => void = () => {}): Renderer {
  return createTerminalRenderer({
    plain: true,
    write: (chunk) => {
      for (const line of chunk.split("\n")) if (line !== "") onLine(line);
    },
  });
}

/** Stamp a deterministic `at` so fixtures can be written without one. */
const stamp = (event: RunEventInput, i: number): RunEvent => ({ ...event, at: i }) as RunEvent;

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

function engineYielding(events: RunEventInput[]): Engine {
  return {
    async *run(): AsyncGenerator<RunEvent> {
      for (const [i, event] of events.entries()) yield stamp(event, i);
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

  test("ship validates resume flags before building a run", async () => {
    const { stderr, exitCode } = await runCli("ship", "--resume");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--resume requires a run id");
  });
});

describe("parseShipArgs", () => {
  test("--plain and --no-tui both set plain; default is the TUI (plain false)", () => {
    expect(parseShipArgs([]).plain).toBe(false);
    expect(parseShipArgs(["--plain"]).plain).toBe(true);
    expect(parseShipArgs(["--no-tui"]).plain).toBe(true);
  });

  test("preserves --verbose, --fresh, and --resume", () => {
    expect(parseShipArgs(["--verbose"]).verbose).toBe(true);
    expect(parseShipArgs(["-v"]).verbose).toBe(true);
    expect(parseShipArgs(["--fresh"]).journalResume).toBe("fresh");
    expect(parseShipArgs(["--resume", "run-7"])).toMatchObject({
      journalResume: "exact",
      runId: "run-7",
    });
    expect(parseShipArgs(["--resume=run-9"])).toMatchObject({
      journalResume: "exact",
      runId: "run-9",
    });
  });

  test("rejects an unknown option", () => {
    expect(() => parseShipArgs(["--bogus"])).toThrow(/Unknown ship option: --bogus/);
  });
});

describe("assembleShipConfig", () => {
  test("zero-config: the default pipeline with the GitHub Git provider + pi Harness", async () => {
    const config = await assembleShipConfig("/repo", NO_CONFIG);

    expect(config.pipeline.map((s) => s.name)).toEqual([
      "branch",
      "describe",
      "commit-change",
      "rebase",
      "format",
      "lint",
      "typecheck",
      "test",
      "review",
      "resync",
      "open-pr",
      "ci-wait",
    ]);
    expect(typeof config.providers.gitProvider.openPullRequest).toBe("function");
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
    try {
      await assembleShipConfig("/repo", { selection: {}, pluginPaths: [path] });
      throw new Error("assembleShipConfig unexpectedly resolved");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toMatch(
        /must `export default` a function/,
      );
    }
  });

  test("names the plugin path when a plugin throws while patching", async () => {
    const path = pluginFile(`export default () => { throw new Error("boom"); };`);
    try {
      await assembleShipConfig("/repo", { selection: {}, pluginPaths: [path] });
      throw new Error("assembleShipConfig unexpectedly resolved");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toMatch(
        new RegExp(`${path.replace(/[/\\]/g, ".")}.*boom`),
      );
    }
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
      renderer: plainRenderer((l) => lines.push(l)),
    });

    expect(code).toBe(0);
    expect(lines).toContain("■ run finished");
  });

  test("returns 1 when the run fails", async () => {
    const code = await ship({
      buildConfig: () => dummyConfig,
      engineFor: () => engineYielding([{ type: "run:failed", step: "test", error: "boom" }]),
      renderer: plainRenderer(),
    });

    expect(code).toBe(1);
  });

  test("returns 130 (SIGINT) on cancellation", async () => {
    const code = await ship({
      buildConfig: () => dummyConfig,
      engineFor: () => engineYielding([{ type: "run:cancelled" }]),
      renderer: plainRenderer(),
    });

    expect(code).toBe(130);
  });

  test("restores the terminal and exits 130 on SIGINT, then removes its handlers", async () => {
    // A signal terminates the process before the `finally` teardown runs, so `ship()`
    // installs handlers that close the renderer (show cursor / end sync) first. Drive the
    // installed handler directly - stubbing `process.exit` so it doesn't kill the runner.
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
        yield { type: "run:started", at: 0, pipeline: [] };
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
        yield { type: "run:started", at: 0, pipeline: [] };
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

  test("a non-interactive renderer wires clear failing Ask/approval responders into the engine", async () => {
    let captured: EngineOptions | undefined;

    const code = await ship({
      buildConfig: () => dummyConfig,
      engineFor: (_config, opts) => {
        captured = opts;
        return engineYielding([{ type: "run:started", pipeline: [] }, { type: "run:finished" }]);
      },
      renderer: plainRenderer(), // the plain renderer supplies no responders
    });

    expect(code).toBe(0);
    const { ask, approveFindings } = captured ?? {};
    expect(typeof ask).toBe("function");
    expect(typeof approveFindings).toBe("function");
    if (ask === undefined || approveFindings === undefined) throw new Error("missing responders");

    const askError = await ask("ship it?").then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(askError).toMatch(/needs an interactive Ask/);

    const approveError = await approveFindings({
      prompt: "Review findings",
      findings: [
        makeFinding("test", {
          disposition: "should-fix",
          action: "ask-user",
          title: "Needs input",
          detail: "decide locally",
        }),
      ],
    }).then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(approveError).toMatch(/needs an interactive findings approval/);
  });

  test("an interactive renderer supplies the engine's Ask/approval responders", async () => {
    let captured: EngineOptions | undefined;
    const interactive: InteractiveRenderer = {
      render() {},
      close() {},
      ask: (prompt) => Promise.resolve(`answered: ${prompt}`),
      approveFindings: () => Promise.resolve({ action: "approve" }),
    };

    await ship({
      buildConfig: () => dummyConfig,
      engineFor: (_config, opts) => {
        captured = opts;
        return engineYielding([{ type: "run:started", pipeline: [] }, { type: "run:finished" }]);
      },
      renderer: interactive,
    });

    const { ask, approveFindings } = captured ?? {};
    if (ask === undefined || approveFindings === undefined) throw new Error("missing responders");
    expect(await ask("ok?")).toBe("answered: ok?");
    expect(await approveFindings({ prompt: "p", findings: [] })).toEqual({ action: "approve" });
  });

  test("a TTY default selects the TUI through the createTui seam; non-TTY and --plain do not", async () => {
    const noopEngine = () =>
      engineYielding([{ type: "run:started", pipeline: [] }, { type: "run:finished" }]);
    let tuiBuilds = 0;
    const fakeTui: InteractiveRenderer = { render() {}, close() {} };
    const createTui = () => {
      tuiBuilds += 1;
      return fakeTui;
    };

    // Interactive TTY → builds the TUI.
    await ship({ buildConfig: () => dummyConfig, engineFor: noopEngine, isTTY: true, createTui });
    expect(tuiBuilds).toBe(1);

    // --plain over a TTY → inline terminal renderer, no TUI.
    await ship({
      buildConfig: () => dummyConfig,
      engineFor: noopEngine,
      isTTY: true,
      plain: true,
      createTui,
    });
    // Non-TTY → plain renderer, no TUI.
    await ship({ buildConfig: () => dummyConfig, engineFor: noopEngine, isTTY: false, createTui });
    expect(tuiBuilds).toBe(1);
  });

  test("prints the renderer epilogue after the run, with the final ViewState", async () => {
    let epilogueStatus: string | undefined;
    const interactive: InteractiveRenderer = {
      render() {},
      close() {},
      epilogue: (view) => {
        epilogueStatus = view.status;
      },
    };

    await ship({
      buildConfig: () => dummyConfig,
      engineFor: () =>
        engineYielding([{ type: "run:started", pipeline: [] }, { type: "run:finished" }]),
      renderer: interactive,
    });

    expect(epilogueStatus).toBe("finished");
  });

  test("returns 1 when engine setup throws", async () => {
    const code = await ship({
      buildConfig: () => dummyConfig,
      engineFor: () => {
        throw new Error("engine construction failed");
      },
      renderer: plainRenderer(),
    });

    expect(code).toBe(1);
  });
});
