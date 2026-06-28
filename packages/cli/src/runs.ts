// `tml runs` (alias `tml ls`) — list the Runs recorded for this checkout, most-recent first. Runs
// are journaled per checkout by `@tml/core`; this reads that history (no Run is started) and prints
// a compact table. A `running` Run is shown by its liveness, so a crash-orphaned Run reads as
// `orphaned`, not a phantom in-progress Run. The TTY picker and the direct viewer build on this.

import {
  classifyLiveness,
  listRuns,
  readRunEvents,
  type RunEvent,
  type RunMetadata,
} from "@tml/core";
import {
  attachThrough,
  createTerminalRenderer,
  displayState,
  type EventSource,
  humanizeAge,
  type Renderer,
  replayThrough,
  runLabel,
  shortRunId,
} from "@tml/view";

// Re-exported so the run-history presentation helpers have one home in @tml/view while staying
// importable from the command module that uses them.
export { displayState, humanizeAge, runLabel, shortRunId };

export interface RunsDeps {
  /** Checkout whose Runs to list. Defaults to process.cwd(). */
  cwd?: string;
  /** Current epoch ms, injected by tests for stable ages. Defaults to Date.now(). */
  now?: number;
  /** List the checkout's Runs. Injected by tests; defaults to the `@tml/core` journal reader. */
  list?: (checkoutPath: string) => Promise<RunMetadata[]>;
  /** Output sink. Defaults to console.log. */
  out?: (line: string) => void;
}

export async function runs(deps: RunsDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? Date.now();
  const list = deps.list ?? ((checkoutPath: string) => listRuns({ checkoutPath }));
  const out = deps.out ?? ((line: string) => console.log(line));

  const all = await list(cwd);
  if (all.length === 0) {
    out("No runs recorded for this checkout yet.");
    return 0;
  }
  for (const line of formatRunsTable(all, now)) out(line);
  return 0;
}

export interface ViewRunDeps {
  /** Checkout the Run belongs to. Defaults to process.cwd(). */
  cwd?: string;
  /** The Run id to view: a full id, the short suffix, or a unique prefix. */
  runId: string;
  /** Current epoch ms; injected by tests. Defaults to Date.now(). */
  now?: number;
  /** Whether stdout is a TTY. Defaults to process.stdout.isTTY. */
  isTTY?: boolean;
  /** Seal the full per-step trail when replaying through the terminal renderer. */
  verbose?: boolean;
  /** Resolve the checkout's Runs (for id matching). Injected by tests. */
  list?: (checkoutPath: string) => Promise<RunMetadata[]>;
  /** Read a Run's recorded events. Injected by tests. */
  readEvents?: (checkoutPath: string, runId: string) => Promise<RunEvent[]>;
  /** The renderer to drive. Injected by tests; defaults to the terminal renderer. */
  renderer?: Renderer;
  /** Wait between attach polls. Injected by tests; defaults to a 500ms sleep. */
  wait?: () => Promise<void>;
  /** Output sink for resolution errors. Defaults to console.log. */
  out?: (line: string) => void;
}

/**
 * View one Run by id. A live Run is attached to (tailed until it ends); any other Run is replayed
 * from its recorded events. Read-only either way - the engine is never involved.
 */
export async function viewRun(deps: ViewRunDeps): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.out ?? ((line: string) => console.log(line));
  const list = deps.list ?? ((checkoutPath: string) => listRuns({ checkoutPath }));
  const readEvents =
    deps.readEvents ??
    (async (checkoutPath: string, runId: string) =>
      (await readRunEvents({ checkoutPath }, runId)).map((record) => record.event));

  const match = resolveRun(await list(cwd), deps.runId);
  if (match === undefined) {
    out(`tml: no run matches "${deps.runId}".`);
    return 1;
  }
  if (Array.isArray(match)) {
    out(`tml: "${deps.runId}" matches ${match.length} runs; use a longer id.`);
    return 1;
  }

  const isTTY = deps.isTTY ?? !!process.stdout.isTTY;
  // A TTY gets the full-screen read-only dashboard (lazy-imported so non-TTY paths never load
  // OpenTUI); piped output replays through the plain terminal renderer.
  let renderer = deps.renderer;
  let detached: (() => boolean) | undefined;
  if (renderer === undefined) {
    if (isTTY) {
      const { createViewerRenderer } = await import("@tml/view/tui");
      const viewer = await createViewerRenderer();
      renderer = viewer;
      detached = () => viewer.dismissed();
    } else {
      renderer = createTerminalRenderer({ plain: true, verbose: deps.verbose ?? false });
    }
  }
  // Attach only to a Run that is actually progressing; an orphaned `running` Run gets no more events,
  // so replay what it has rather than polling forever.
  const live =
    match.status === "running" &&
    classifyLiveness(match, { now: deps.now ?? Date.now() }) !== "orphaned";
  try {
    if (live) {
      const source: EventSource = { read: () => readEvents(cwd, match.runId) };
      const wait = deps.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
      await attachThrough(renderer, source, { wait, detached });
    } else {
      await replayThrough(renderer, await readEvents(cwd, match.runId));
    }
  } finally {
    renderer.close();
  }
  return 0;
}

/**
 * Resolve a Run id query against the checkout's Runs: an exact id wins; otherwise match the short
 * suffix or a unique prefix. Returns the array of candidates when the query is ambiguous.
 */
export function resolveRun(
  all: readonly RunMetadata[],
  query: string,
): RunMetadata | RunMetadata[] | undefined {
  const exact = all.find((run) => run.runId === query);
  if (exact !== undefined) return exact;
  const matches = all.filter(
    (run) => shortRunId(run.runId) === query || run.runId.startsWith(query),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return matches;
  return undefined;
}

const COLUMNS = ["STATE", "BRANCH", "ID", "AGE", "PR"] as const;

/** Render the Runs as an aligned, header-led table. Pure: the command does the I/O. */
export function formatRunsTable(all: readonly RunMetadata[], now: number): string[] {
  const rows = all.map((run) => [
    displayState(run, now),
    runLabel(run),
    shortRunId(run.runId),
    humanizeAge(now - Date.parse(run.updatedAt)),
    run.prUrl ?? "",
  ]);
  const widths = COLUMNS.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => row[col]?.length ?? 0)),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join("  ")
      .trimEnd();
  return [render(COLUMNS), ...rows.map(render)];
}
