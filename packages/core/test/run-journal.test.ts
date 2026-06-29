import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkoutKeyForPath,
  createRunJournal,
  listRuns,
  readRun,
  readRunEvents,
} from "../src/run-journal.ts";

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
    await journal.recordEvent({ type: "run:started", at: 0, pipeline: ["produce"] });
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
    await first.recordRound({ step: "produce", index: 0, trigger: "initial", findings: [] });
    await first.recordStepCompleted("produce");

    const second = createRunJournal({ stateHome, checkoutPath, runId: "run-1", events: false });
    const snapshot = await second.begin({ pipeline: ["produce", "consume"] });

    expect(snapshot.metadata.runId).toBe("run-1");
    expect([...snapshot.completedSteps]).toEqual(["produce"]);
    expect(snapshot.artifacts.get("raw")).toBe("hi");
    expect(snapshot.rounds).toEqual([
      { step: "produce", index: 0, trigger: "initial", findings: [] },
    ]);
    expect([...snapshot.roundIndexes]).toEqual([["produce", 1]]);
  });

  test("auto resume is scoped to the branch (resumeKey): a run on the base branch starts fresh", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const pipeline = ["branch", "commit"];

    // A prior shipment started on master, cut a feature branch, then failed (left parked).
    const first = createRunJournal({ stateHome, checkoutPath, resume: "fresh", events: false });
    const firstSnapshot = await first.begin({ pipeline, resumeKey: "master" });
    const firstRunId = firstSnapshot.metadata.runId;
    await first.recordResumeKey("feat/x"); // the branch Step moved HEAD onto the feature branch
    await first.recordStepCompleted("branch");
    await first.finish("failed");

    // A fresh `tml ship` back on master must NOT resume that shipment - it starts clean.
    const onMaster = createRunJournal({ stateHome, checkoutPath, resume: "auto", events: false });
    const masterSnapshot = await onMaster.begin({ pipeline, resumeKey: "master" });
    expect(masterSnapshot.metadata.runId).not.toBe(firstRunId);
    expect([...masterSnapshot.completedSteps]).toEqual([]);

    // Re-running while still on the feature branch resumes the parked shipment.
    const onFeature = createRunJournal({ stateHome, checkoutPath, resume: "auto", events: false });
    const featureSnapshot = await onFeature.begin({ pipeline, resumeKey: "feat/x" });
    expect(featureSnapshot.metadata.runId).toBe(firstRunId);
    expect([...featureSnapshot.completedSteps]).toEqual(["branch"]);
  });

  test("auto resume matches a legacy keyless run when no branch key is available", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const pipeline = ["branch", "commit"];

    const legacy = createRunJournal({ stateHome, checkoutPath, resume: "fresh", events: false });
    const legacyId = (await legacy.begin({ pipeline })).metadata.runId; // no resumeKey recorded
    await legacy.recordStepCompleted("branch");
    await legacy.finish("failed");

    const next = createRunJournal({ stateHome, checkoutPath, resume: "auto", events: false });
    const snapshot = await next.begin({ pipeline }); // also keyless
    expect(snapshot.metadata.runId).toBe(legacyId);
    expect([...snapshot.completedSteps]).toEqual(["branch"]);
  });

  test("a parked run is resumable; a finished run is not", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const pipeline = ["branch", "commit"];

    // A shipment reached a ready PR and parked (resumable rest).
    const parked = createRunJournal({ stateHome, checkoutPath, resume: "fresh", events: false });
    const parkedId = (await parked.begin({ pipeline, resumeKey: "feat/x" })).metadata.runId;
    await parked.recordStepCompleted("branch");
    await parked.finish("parked");

    // The next `--watch` tick (auto resume on the same branch) picks the parked run up and flips it
    // back to running.
    const resumed = createRunJournal({ stateHome, checkoutPath, resume: "auto", events: false });
    const resumedSnapshot = await resumed.begin({ pipeline, resumeKey: "feat/x" });
    expect(resumedSnapshot.metadata.runId).toBe(parkedId);
    expect(resumedSnapshot.metadata.status).toBe("running");
    expect([...resumedSnapshot.completedSteps]).toEqual(["branch"]);

    // Once the PR lands the run finishes; a finished run is never resumed - a re-run starts fresh.
    await resumed.finish("finished");
    const after = createRunJournal({ stateHome, checkoutPath, resume: "auto", events: false });
    const afterSnapshot = await after.begin({ pipeline, resumeKey: "feat/x" });
    expect(afterSnapshot.metadata.runId).not.toBe(parkedId);
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

    for (const status of ["finished", "parked", "failed", "cancelled"] as const) {
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
    await journal.recordEvent({ type: "run:started", at: 0, pipeline: ["produce"] });

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

  test("denormalizes pr url, failure, finishedAt, and owner onto run.json", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "run-1" });
    await journal.begin({ pipeline: ["produce"] });
    await journal.recordEvent({ type: "pr:opened", at: 1, url: "https://example/pull/7" });
    await journal.recordEvent({ type: "run:failed", at: 2, step: "produce", error: "boom" });
    await journal.finish("failed");

    const runDir = join(stateHome, "tml", checkoutKeyForPath(checkoutPath), "runs", "run-1");
    const metadata = readJson(join(runDir, "run.json")) as {
      prUrl?: string;
      failureSummary?: string;
      finishedAt?: string;
      status: string;
      owner?: { pid: number; host: string };
    };
    expect(metadata.prUrl).toBe("https://example/pull/7");
    expect(metadata.failureSummary).toBe("boom");
    expect(metadata.status).toBe("failed");
    expect(typeof metadata.finishedAt).toBe("string");
    expect(metadata.owner?.pid).toBe(process.pid);
    expect(typeof metadata.owner?.host).toBe("string");
  });

  test("denormalizes the pr url even when the event stream is not persisted", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "run-1", events: false });
    await journal.begin({ pipeline: ["produce"] });
    await journal.recordEvent({ type: "pr:opened", at: 1, url: "https://example/pull/9" });

    const run = await readRun({ stateHome, checkoutPath }, "run-1");
    expect(run?.prUrl).toBe("https://example/pull/9");
  });

  test("listRuns returns every run for the checkout, newest-updated first", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");

    const older = createRunJournal({ stateHome, checkoutPath, runId: "older" });
    await older.begin({ pipeline: ["produce"] });
    await older.finish("finished");

    const newer = createRunJournal({ stateHome, checkoutPath, runId: "newer" });
    await newer.begin({ pipeline: ["produce"] });

    const runs = await listRuns({ stateHome, checkoutPath });
    expect(runs.map((run) => run.runId)).toEqual(["newer", "older"]);
    expect(runs[0]?.status).toBe("running");
    expect(runs[1]?.status).toBe("finished");
  });

  test("listRuns and readRunEvents are empty for an unknown checkout", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "never-run");
    expect(await listRuns({ stateHome, checkoutPath })).toEqual([]);
    expect(await readRunEvents({ stateHome, checkoutPath }, "missing")).toEqual([]);
    expect(await readRun({ stateHome, checkoutPath }, "missing")).toBeUndefined();
  });

  test("refuses to resume a run whose owner is a live, different process", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const first = createRunJournal({ stateHome, checkoutPath, runId: "run-1" });
    await first.begin({ pipeline: ["produce"] });

    // Rewrite the owner to our live parent process: a different pid that is genuinely alive.
    const runDir = join(stateHome, "tml", checkoutKeyForPath(checkoutPath), "runs", "run-1");
    const metaPath = join(runDir, "run.json");
    const metadata = JSON.parse(readFileSync(metaPath, "utf8"));
    metadata.owner = { pid: process.ppid, host: hostname() };
    writeFileSync(metaPath, JSON.stringify(metadata));

    const second = createRunJournal({ stateHome, checkoutPath, runId: "run-1", resume: "exact" });
    const error = await rejection(second.begin({ pipeline: ["produce"] }));
    expect((error as Error).message).toMatch(/already in progress/);
  });

  test("reclaims a run whose owner is a dead process", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const first = createRunJournal({ stateHome, checkoutPath, runId: "run-1" });
    await first.begin({ pipeline: ["produce"] });

    const runDir = join(stateHome, "tml", checkoutKeyForPath(checkoutPath), "runs", "run-1");
    const metaPath = join(runDir, "run.json");
    const metadata = JSON.parse(readFileSync(metaPath, "utf8"));
    metadata.owner = { pid: 999_999, host: hostname() }; // beyond PID_MAX: certainly dead
    writeFileSync(metaPath, JSON.stringify(metadata));

    const second = createRunJournal({ stateHome, checkoutPath, runId: "run-1", resume: "exact" });
    await second.begin({ pipeline: ["produce"] });
    const reclaimed = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(reclaimed.owner.pid).toBe(process.pid);
    expect(reclaimed.status).toBe("running");
  });

  test("readRunEvents replays the recorded event stream in order", async () => {
    const stateHome = tempDir();
    const checkoutPath = join(stateHome, "repo");
    const journal = createRunJournal({ stateHome, checkoutPath, runId: "run-1" });
    await journal.begin({ pipeline: ["produce"] });
    await journal.recordEvent({ type: "run:started", at: 0, pipeline: ["produce"] });
    await journal.recordEvent({ type: "step:started", at: 1, step: "produce" });
    await journal.recordEvent({ type: "run:finished", at: 2 });
    await journal.finish("finished");

    const records = await readRunEvents({ stateHome, checkoutPath }, "run-1");
    expect(records.map((record) => record.event.type)).toEqual([
      "run:started",
      "step:started",
      "run:finished",
    ]);
    expect(typeof records[0]?.recordedAt).toBe("string");
  });
});
