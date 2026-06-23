import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineArtifact } from "../src/artifact.ts";
import { createEngine } from "../src/engine.ts";
import type { RunEvent, RunEventInput } from "../src/events.ts";
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

/** Strip the engine-stamped `at` so event-shape assertions stay timestamp-agnostic. */
function withoutAt(event: RunEvent): RunEventInput {
  const copy = { ...event } as { at?: number };
  delete copy.at;
  return copy as RunEventInput;
}

async function collect(config: Config, journal = createRunJournal({ stateHome: tempDir() })) {
  const events: RunEventInput[] = [];
  for await (const event of createEngine(config, { journal }).run()) events.push(withoutAt(event));
  return events;
}

const raw = defineArtifact<string>()("raw");
const derived = defineArtifact<number>()("derived");

describe("engine RunJournal integration", () => {
  test("restores artifacts and skips completed replayable steps", async () => {
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

    expect(produceRuns).toBe(0);
    expect(events).toContainEqual({ type: "step:skipped", step: "produce" });
    expect(events).not.toContainEqual({ type: "step:started", step: "produce" });
    expect(events).toContainEqual({ type: "step:log", step: "consume", message: "raw=hi" });
    expect(events.at(-1)).toEqual({ type: "run:finished" });
  });

  test("fails instead of replaying a completed step with missing artifacts", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "missing", events: false });
    await journal.begin({ pipeline: ["produce"] });
    await journal.recordStepCompleted("produce");

    const produce = defineStep({
      name: "produce",
      produces: [raw],
      run: () => Promise.resolve({ raw: "rerun" }),
    });

    const events = await collect(
      {
        pipeline: [produce],
        providers: { gitProvider: new FakeGitProvider(), agent: new FakeHarness() },
      },
      journal,
    );
    const last = events.at(-1);

    expect(last).toMatchObject({ type: "run:failed", step: "produce" });
    expect(last && "error" in last ? last.error : "").toContain("missing artifact");
  });

  test("reconcile steps are not skipped and stop later journal replay", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "post-pr", events: false });
    await journal.begin({ pipeline: ["local", "open-pr", "ci"] });
    await journal.recordArtifact({ step: "local", artifact: "raw", value: "hi" });
    await journal.recordRound({ step: "local", index: 0, trigger: "initial", findings: [] });
    await journal.recordStepCompleted("local");
    await journal.recordStepCompleted("open-pr");
    await journal.recordRound({ step: "ci", index: 0, trigger: "initial", findings: [] });
    await journal.recordStepCompleted("ci");

    const runs: string[] = [];
    const local = defineStep({
      name: "local",
      produces: [raw],
      run() {
        runs.push("local");
        return Promise.resolve({ raw: "rerun" });
      },
    });
    const openPr = defineStep({
      name: "open-pr",
      consumes: [raw],
      resume: "reconcile",
      run(ctx) {
        runs.push(
          `open-pr:${ctx.read(raw)}:${ctx
            .rounds()
            .map((round) => round.step)
            .join(",")}`,
        );
        return Promise.resolve({});
      },
    });
    const ci = defineStep({
      name: "ci",
      run() {
        runs.push("ci");
        return Promise.resolve({});
      },
    });

    const events = await collect(
      {
        pipeline: [local, openPr, ci],
        providers: { gitProvider: new FakeGitProvider(), agent: new FakeHarness() },
      },
      journal,
    );

    expect(runs).toEqual(["open-pr:hi:local", "ci"]);
    expect(events).toContainEqual({ type: "step:skipped", step: "local" });
    expect(events).toContainEqual({ type: "step:started", step: "open-pr" });
    expect(events).toContainEqual({ type: "step:started", step: "ci" });
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
