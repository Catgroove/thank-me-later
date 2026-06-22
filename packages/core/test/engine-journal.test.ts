import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineArtifact } from "../src/artifact.ts";
import { createEngine } from "../src/engine.ts";
import type { RunEvent } from "../src/events.ts";
import type { Config } from "../src/pipeline.ts";
import { checkoutKeyForPath, createRunJournal } from "../src/run-journal.ts";
import { defineStep } from "../src/step.ts";
import { FakeGitProvider, FakeHarness } from "./fakes.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tml-engine-journal-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function collect(config: Config, journal = createRunJournal({ stateHome: tempDir() })) {
  const events: RunEvent[] = [];
  for await (const event of createEngine(config, { journal }).run()) events.push(event);
  return events;
}

const raw = defineArtifact<string>()("raw");
const derived = defineArtifact<number>()("derived");

describe("engine RunJournal integration", () => {
  test("records state without replaying completed steps before resume policy exists", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "resume", events: false });
    await journal.begin({ pipeline: ["produce", "consume"] });
    await journal.recordArtifact({ step: "produce", artifact: "raw", value: "hi" });
    await journal.recordStepCompleted("produce");

    let produceRuns = 0;
    const produce = defineStep({
      name: "produce",
      produces: [raw],
      run() {
        produceRuns += 1;
        return Promise.resolve({ raw: "rerun" });
      },
    });
    const consume = defineStep({
      name: "consume",
      consumes: [raw],
      produces: [derived],
      run(ctx) {
        const value = ctx.read(raw);
        ctx.log(`raw=${value}`);
        return Promise.resolve({ derived: value.length });
      },
    });

    const events = await collect(
      {
        pipeline: [produce, consume],
        providers: { gitProvider: new FakeGitProvider(), agent: new FakeHarness() },
      },
      journal,
    );

    expect(produceRuns).toBe(1);
    expect(events).toContainEqual({ type: "step:started", step: "produce" });
    expect(events).toContainEqual({ type: "step:log", step: "consume", message: "raw=rerun" });
    expect(events.at(-1)).toEqual({ type: "run:finished" });
  });

  test("persists step rounds and optional events", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "rounds" });
    const review = defineStep({
      name: "review",
      async run() {
        return {
          artifacts: {},
          rounds: [{ trigger: "initial" as const, findings: [] }],
        };
      },
    });

    await collect(
      {
        pipeline: [review],
        providers: { gitProvider: new FakeGitProvider(), agent: new FakeHarness() },
      },
      journal,
    );

    const runDir = join(stateHome, "tml", checkoutKeyForPath(checkoutPath), "runs", "rounds");
    const round = JSON.parse(readFileSync(join(runDir, "rounds.jsonl"), "utf8").trim());
    expect(round).toMatchObject({
      step: "review",
      index: 0,
      trigger: "initial",
      findings: [],
    });
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain("run:finished");
  });
});
