import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutKeyForPath, createRunJournal } from "../src/run-journal.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tml-journal-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("RunJournal", () => {
  test("persists run metadata, artifacts, rounds, and events in the checkout state tree", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "run-1" });

    await journal.begin({ pipeline: ["produce"] });
    await journal.recordArtifact({ step: "produce", artifact: "raw/value", value: { n: 1 } });
    await journal.recordStepCompleted("produce");
    await journal.recordRound({
      step: "produce",
      index: 0,
      trigger: "initial",
      findings: [],
    });
    await journal.recordEvent({ type: "run:started", pipeline: ["produce"] });
    await journal.finish("finished");

    const runDir = join(stateHome, "tml", checkoutKeyForPath(checkoutPath), "runs", "run-1");
    expect(readJson(join(runDir, "run.json"))).toMatchObject({
      runId: "run-1",
      checkoutKey: checkoutKeyForPath(checkoutPath),
      checkoutPath,
      pipeline: ["produce"],
      status: "finished",
      completedSteps: ["produce"],
    });
    expect(readJson(join(runDir, "artifacts", "raw%2Fvalue.json"))).toMatchObject({
      artifact: "raw/value",
      step: "produce",
      value: { n: 1 },
    });
    expect(readFileSync(join(runDir, "rounds.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain("run:started");
  });

  test("loads a running journal snapshot by explicit run id", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const first = createRunJournal({ stateHome, checkoutPath, runId: "run-1", events: false });
    await first.begin({ pipeline: ["produce", "consume"] });
    await first.recordArtifact({ step: "produce", artifact: "raw", value: "hi" });
    await first.recordStepCompleted("produce");

    const second = createRunJournal({ stateHome, checkoutPath, runId: "run-1", events: false });
    const snapshot = await second.begin({ pipeline: ["produce", "consume"] });

    expect(snapshot.metadata.runId).toBe("run-1");
    expect([...snapshot.completedSteps]).toEqual(["produce"]);
    expect(snapshot.artifacts.get("raw")).toBe("hi");
  });

  test("rejects resuming an incompatible pipeline", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const first = createRunJournal({ stateHome, checkoutPath, runId: "run-1", events: false });
    await first.begin({ pipeline: ["produce", "consume"] });

    const second = createRunJournal({ stateHome, checkoutPath, runId: "run-1", events: false });
    expect(String(await rejection(second.begin({ pipeline: ["produce", "different"] })))).toMatch(
      /Pipeline no longer matches/,
    );
  });

  test("persists terminal run status transitions", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");

    for (const status of ["finished", "failed", "cancelled"] as const) {
      const journal = createRunJournal({ stateHome, checkoutPath, runId: status, events: false });
      await journal.begin({ pipeline: ["produce"] });
      await journal.finish(status);

      const runDir = join(stateHome, "tml", checkoutKeyForPath(checkoutPath), "runs", status);
      expect(readJson(join(runDir, "run.json"))).toMatchObject({ status });
    }
  });

  test("creates journal directories and files with private permissions", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "private" });

    await journal.begin({ pipeline: ["produce"] });
    await journal.recordArtifact({ step: "produce", artifact: "raw", value: "hi" });
    await journal.recordRound({
      step: "produce",
      index: 0,
      trigger: "initial",
      findings: [],
    });
    await journal.recordEvent({ type: "run:started", pipeline: ["produce"] });

    const checkoutStateDir = join(stateHome, "tml", checkoutKeyForPath(checkoutPath));
    const runDir = join(checkoutStateDir, "runs", "private");
    expect(mode(join(stateHome, "tml"))).toBe(0o700);
    expect(mode(checkoutStateDir)).toBe(0o700);
    expect(mode(join(checkoutStateDir, "runs"))).toBe(0o700);
    expect(mode(runDir)).toBe(0o700);
    expect(mode(join(runDir, "artifacts"))).toBe(0o700);
    expect(mode(join(runDir, "run.json"))).toBe(0o600);
    expect(mode(join(runDir, "artifacts", "raw.json"))).toBe(0o600);
    expect(mode(join(runDir, "rounds.jsonl"))).toBe(0o600);
    expect(mode(join(runDir, "events.jsonl"))).toBe(0o600);
  });

  test("rejects run ids that are not safe path segments", () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");

    expect(() => createRunJournal({ stateHome, checkoutPath, runId: "../escape" })).toThrow(
      /runId/,
    );
    expect(() => createRunJournal({ stateHome, checkoutPath, runId: ".." })).toThrow(/runId/);
    expect(() => createRunJournal({ stateHome, checkoutPath, runId: "nested/run" })).toThrow(
      /runId/,
    );
    expect(() => createRunJournal({ stateHome, checkoutPath, runId: "run\\nested" })).toThrow(
      /runId/,
    );
    expect(() => createRunJournal({ stateHome, checkoutPath, runId: "run..nested" })).toThrow(
      /runId/,
    );
  });
});
