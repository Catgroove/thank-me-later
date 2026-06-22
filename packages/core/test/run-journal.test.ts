import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("RunJournal", () => {
  test("persists run metadata, artifacts, rounds, and events in the checkout state tree", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "run-1" });

    await journal.begin({ pipeline: ["produce"] });
    await journal.recordArtifact({ step: "produce", artifact: "raw/value", value: { n: 1 } });
    await journal.recordStepCompleted("produce");
    await journal.append({
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

  test("loads a running journal snapshot for resume", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const first = createRunJournal({ stateHome, checkoutPath, runId: "run-1", events: false });
    await first.begin({ pipeline: ["produce", "consume"] });
    await first.recordArtifact({ step: "produce", artifact: "raw", value: "hi" });
    await first.recordStepCompleted("produce");

    const second = createRunJournal({ stateHome, checkoutPath, events: false });
    const snapshot = await second.begin({ pipeline: ["produce", "consume"] });

    expect(snapshot.metadata.runId).toBe("run-1");
    expect([...snapshot.completedSteps]).toEqual(["produce"]);
    expect(snapshot.artifacts.get("raw")).toBe("hi");
  });
});
