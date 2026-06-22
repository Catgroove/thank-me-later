// File-backed Run Journal. The journal records what this machine executed: local
// Run metadata, completed Steps, artifact values, round records, and an optional
// Event stream. Git provider state remains a live Provider read: PRs, comments,
// checks, and mergeability are not cached here.

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RunEvent } from "./events.ts";
import type { RoundRecord } from "./round.ts";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export type RunStatus = "running" | "finished" | "failed" | "cancelled";

export interface RunMetadata {
  readonly runId: string;
  readonly checkoutKey: string;
  readonly checkoutPath: string;
  readonly pipeline: string[];
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedSteps: string[];
}

export interface RunJournalSnapshot {
  readonly metadata: RunMetadata;
  readonly artifacts: ReadonlyMap<string, unknown>;
  readonly completedSteps: ReadonlySet<string>;
}

export interface RunJournal {
  /** Load an existing resumable run for this checkout, or create a new one. */
  begin(input: { pipeline: string[] }): Promise<RunJournalSnapshot>;
  /** Persist an artifact value before its producing Step is marked complete. */
  recordArtifact(input: { step: string; artifact: string; value: unknown }): Promise<void>;
  /** Mark a Step complete after all of its artifacts have been persisted. */
  recordStepCompleted(step: string): Promise<void>;
  /** Append one completed Step round for the local Run record. */
  append(round: RoundRecord): Promise<void>;
  /** Append one Run event when event persistence is enabled. */
  recordEvent(event: RunEvent): Promise<void>;
  /** Close the local Run record with its terminal status. */
  finish(status: Exclude<RunStatus, "running">): Promise<void>;
}

export interface CreateRunJournalOptions {
  /** Checkout whose local machine execution is being journaled. Defaults to process.cwd(). */
  checkoutPath?: string;
  /** Override the XDG state root in tests. Defaults to $XDG_STATE_HOME or ~/.local/state. */
  stateHome?: string;
  /** Environment lookup for XDG_STATE_HOME. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Resume this exact run id instead of selecting the latest running compatible run. */
  runId?: string;
  /** Persist events.jsonl. Defaults to true. */
  events?: boolean;
}

export function createRunJournal(opts: CreateRunJournalOptions = {}): RunJournal {
  const env = opts.env ?? process.env;
  const checkoutPath = resolve(opts.checkoutPath ?? process.cwd());
  const checkoutKey = checkoutKeyForPath(checkoutPath);
  const stateHome = opts.stateHome ?? defaultStateHome(env);
  return new FileRunJournal({
    root: join(stateHome, "tml", checkoutKey),
    checkoutKey,
    checkoutPath,
    runId: opts.runId,
    events: opts.events ?? true,
  });
}

export function checkoutKeyForPath(path: string): string {
  const absolute = resolve(path);
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
  return `${safeSegment(basename(absolute) || "checkout")}-${digest}`;
}

function defaultStateHome(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_STATE_HOME;
  return xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
}

interface FileRunJournalOptions {
  readonly root: string;
  readonly checkoutKey: string;
  readonly checkoutPath: string;
  readonly runId?: string;
  readonly events: boolean;
}

class FileRunJournal implements RunJournal {
  private readonly root: string;
  private readonly checkoutKey: string;
  private readonly checkoutPath: string;
  private readonly requestedRunId: string | undefined;
  private readonly events: boolean;
  private runDir: string | undefined;
  private metadata: RunMetadata | undefined;

  constructor(opts: FileRunJournalOptions) {
    this.root = opts.root;
    this.checkoutKey = opts.checkoutKey;
    this.checkoutPath = opts.checkoutPath;
    this.requestedRunId = opts.runId === undefined ? undefined : validateRunId(opts.runId);
    this.events = opts.events;
  }

  async begin(input: { pipeline: string[] }): Promise<RunJournalSnapshot> {
    const pipeline = [...input.pipeline];
    const { runId, metadata } = await this.selectRun(pipeline);
    const runsDir = join(this.root, "runs");
    this.runDir = join(runsDir, runId);
    await ensurePrivateDir(dirname(this.root));
    await ensurePrivateDir(this.root);
    await ensurePrivateDir(runsDir);
    await ensurePrivateDir(this.runDir);
    await ensurePrivateDir(join(this.runDir, "artifacts"));

    if (metadata === undefined) {
      const now = new Date().toISOString();
      this.metadata = {
        runId,
        checkoutKey: this.checkoutKey,
        checkoutPath: this.checkoutPath,
        pipeline,
        status: "running",
        startedAt: now,
        updatedAt: now,
        completedSteps: [],
      };
      await this.writeMetadata();
    } else {
      const resumed: RunMetadata =
        metadata.status === "running" ? metadata : { ...metadata, status: "running" };
      this.metadata = { ...resumed, runId };
      await this.writeMetadata();
    }

    const artifacts = await this.readArtifacts();
    const currentMetadata = this.requireMetadata();
    return {
      metadata: currentMetadata,
      artifacts,
      completedSteps: new Set(currentMetadata.completedSteps),
    };
  }

  async recordArtifact(input: { step: string; artifact: string; value: unknown }): Promise<void> {
    const runDir = this.requireRunDir();
    const writtenAt = new Date().toISOString();
    await writeJsonAtomic(join(runDir, "artifacts", artifactFile(input.artifact)), {
      artifact: input.artifact,
      step: input.step,
      writtenAt,
      value: input.value,
    });
    this.touch(writtenAt);
    await this.writeMetadata();
  }

  async recordStepCompleted(step: string): Promise<void> {
    const metadata = this.requireMetadata();
    if (!metadata.completedSteps.includes(step)) {
      this.metadata = {
        ...metadata,
        completedSteps: [...metadata.completedSteps, step],
        updatedAt: new Date().toISOString(),
      };
      await this.writeMetadata();
    }
  }

  async append(round: RoundRecord): Promise<void> {
    await appendJsonLine(join(this.requireRunDir(), "rounds.jsonl"), round);
    this.touch(new Date().toISOString());
    await this.writeMetadata();
  }

  async recordEvent(event: RunEvent): Promise<void> {
    if (!this.events) return;
    await appendJsonLine(join(this.requireRunDir(), "events.jsonl"), {
      recordedAt: new Date().toISOString(),
      event,
    });
  }

  async finish(status: Exclude<RunStatus, "running">): Promise<void> {
    const metadata = this.requireMetadata();
    this.metadata = { ...metadata, status, updatedAt: new Date().toISOString() };
    await this.writeMetadata();
  }

  private async selectRun(pipeline: string[]): Promise<{
    runId: string;
    metadata: RunMetadata | undefined;
  }> {
    if (this.requestedRunId !== undefined) {
      const metadata = await readMetadataIfExists(join(this.root, "runs", this.requestedRunId));
      if (metadata !== undefined) assertCompatible(metadata, pipeline, this.requestedRunId);
      return { runId: this.requestedRunId, metadata };
    }

    const active = await latestRunningCompatibleRun(this.root, pipeline);
    return active ?? { runId: newRunId(), metadata: undefined };
  }

  private async readArtifacts(): Promise<Map<string, unknown>> {
    const runDir = this.requireRunDir();
    const artifactsDir = join(runDir, "artifacts");
    const artifacts = new Map<string, unknown>();
    if (!existsSync(artifactsDir)) return artifacts;
    for (const file of await readdir(artifactsDir)) {
      if (!file.endsWith(".json")) continue;
      const parsed = JSON.parse(await readFile(join(artifactsDir, file), "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || !("artifact" in parsed)) continue;
      const record = parsed as { artifact: unknown; value?: unknown };
      if (typeof record.artifact === "string") artifacts.set(record.artifact, record.value);
    }
    return artifacts;
  }

  private touch(updatedAt: string): void {
    const metadata = this.requireMetadata();
    this.metadata = { ...metadata, updatedAt };
  }

  private requireRunDir(): string {
    if (this.runDir === undefined) throw new Error("RunJournal.begin must be called first.");
    return this.runDir;
  }

  private requireMetadata(): RunMetadata {
    if (this.metadata === undefined) throw new Error("RunJournal.begin must be called first.");
    return this.metadata;
  }

  private async writeMetadata(): Promise<void> {
    await writeJsonAtomic(join(this.requireRunDir(), "run.json"), this.requireMetadata());
  }
}

async function latestRunningCompatibleRun(
  root: string,
  pipeline: string[],
): Promise<{ runId: string; metadata: RunMetadata } | undefined> {
  const runsDir = join(root, "runs");
  if (!existsSync(runsDir)) return undefined;
  const candidates: { runId: string; metadata: RunMetadata }[] = [];
  for (const runId of await readdir(runsDir)) {
    if (!isValidRunId(runId)) continue;
    const metadata = await readMetadataIfExists(join(runsDir, runId));
    if (metadata?.status === "running" && samePipeline(metadata.pipeline, pipeline)) {
      candidates.push({ runId, metadata });
    }
  }
  candidates.sort((a, b) => b.metadata.updatedAt.localeCompare(a.metadata.updatedAt));
  return candidates[0];
}

async function readMetadataIfExists(runDir: string): Promise<RunMetadata | undefined> {
  const path = join(runDir, "run.json");
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(await readFile(path, "utf8")) as RunMetadata;
  return parsed;
}

function assertCompatible(metadata: RunMetadata, pipeline: string[], runId: string): void {
  if (!samePipeline(metadata.pipeline, pipeline)) {
    throw new Error(`tml: cannot resume run ${runId}: the Pipeline no longer matches the journal.`);
  }
}

function samePipeline(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((step, i) => step === b[i]);
}

function newRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function artifactFile(artifact: string): string {
  return `${encodeURIComponent(artifact)}.json`;
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment.length > 0 ? segment : "checkout";
}

function validateRunId(runId: string): string {
  if (isValidRunId(runId)) return runId;
  throw new Error(
    "tml: runId must be a non-empty path segment using only letters, numbers, dots, underscores, and hyphens, and must not be '.' or contain '..'.",
  );
}

function isValidRunId(runId: string): boolean {
  return runId.length > 0 && runId !== "." && !runId.includes("..") && RUN_ID_PATTERN.test(runId);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const text = stringifyJson(value);
  await appendFile(path, `${text}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const text = `${stringifyJson(value)}\n`;
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await rename(tmp, path);
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(path, PRIVATE_DIR_MODE);
}

function stringifyJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("RunJournal can only persist JSON-serializable values.");
  return text;
}
