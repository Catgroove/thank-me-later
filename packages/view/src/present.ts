// The presenter — a pure reducer that folds the engine's fine-grained event stream
// into a `ViewState`. No I/O, no clock, no ANSI: elapsed
// time and drawing are the renderers' concern. The CLI renders it, the TUI renders it,
// Adapters later — all share this fold, so they cannot drift. It mirrors the engine's
// other reducers: a `switch (event.type)` returning a new state, never mutating input.
//
// The state is per-Step facts, not active-Step-only buffers: every Step keeps its own
// status, timestamps, artifacts, rounds, findings, and a bounded activity trail, so a
// consumer (the TUI) can inspect any Step at any time. Durable facts (statuses,
// timestamps, artifacts, rounds, findings, PR URL, terminal state) are retained for the
// whole Run; only noisy activity is bounded. The top-level `text`/`tool`/`logs` mirror
// the *active* Step's live buffers - the append-only terminal renderer consumes those.

import type { ApproveFindingsInput, Finding, RoundRecord, RunEvent } from "@tml/core";

/** Current tool activity, with a short human label (e.g. bash → the command). */
export interface ToolView {
  readonly name: string;
  readonly detail?: string;
}

/** One produced artifact: its declared name and (for string values) its rendered form. */
export interface ArtifactView {
  readonly name: string;
  readonly rendered?: string;
  readonly at: number;
}

/**
 * One observable span of work within a Step (e.g. a single review pass), folded from
 * `phase:started`/`phase:finished`. `findings` are the phase's own findings, surfaced live ahead
 * of the deduped authoritative set on the Step's rounds. Phases accumulate across the Step's run;
 * `group` (e.g. a round label) lets a presenter show only the current group.
 */
export interface PhaseView {
  readonly phaseId?: string;
  readonly label: string;
  readonly group?: string;
  readonly status: "active" | "done" | "failed";
  readonly findings: Finding[];
  readonly startedAt: number;
  readonly finishedAt?: number;
}

/** One bounded entry in a Step's (or the Run's) recent-activity trail. */
export interface ActivityEntry {
  readonly at: number;
  readonly step: string;
  readonly kind: "text" | "tool" | "log";
  readonly text?: string;
  readonly tool?: ToolView;
  readonly phase?: "start" | "end";
}

export interface StepView {
  readonly name: string;
  readonly status: "pending" | "active" | "done" | "skipped" | "failed";
  readonly startedAt?: number;
  readonly finishedAt?: number;
  /** Wall time the Step ran, excluding any spell blocked on a human decision (see `waitedMs`). */
  readonly durationMs?: number;
  /**
   * Total time the Step spent blocked on a pending interaction (an `ask`/`approval` gate). It is
   * excluded from `durationMs` and from live elapsed, so a Step's clock reflects work, not the human
   * deliberating. Accumulates across multiple gates within one Step.
   */
  readonly waitedMs?: number;
  /** Every artifact the Step produced, in declared order. */
  readonly artifacts: ArtifactView[];
  /**
   * The step's headline artifact in human string form (its first string-valued artifact). The
   * renderer surfaces short ones inline on the result line and long ones in the results block.
   */
  readonly headline?: string;
  /** Completed Round records for the Step, in recorded order. */
  readonly rounds: RoundRecord[];
  /** Current findings: the findings from the Step's latest recorded Round. */
  readonly findings: Finding[];
  /** Bounded recent activity for the Step (agent text, tool calls, log lines). */
  readonly activity: readonly ActivityEntry[];
  /** Observable phases the Step opened, in start order. Empty for Steps that declare none. */
  readonly phases: PhaseView[];
  /** The current tool while the Step is active, set on `start` and cleared on `end`. */
  readonly currentTool?: ToolView;
  readonly error?: string;
}

export type PendingInteraction =
  | { readonly kind: "ask"; readonly step: string; readonly prompt: string; readonly at: number }
  | {
      readonly kind: "approval";
      readonly step: string;
      readonly input: ApproveFindingsInput;
      readonly at: number;
    };

export interface ViewState {
  /** Steps in pipeline order, seeded from `run:started`. */
  readonly steps: StepView[];
  /** The name of the step currently running, or undefined between/after steps. */
  readonly activeStep?: string;
  /** Run start timestamp, from `run:started`. */
  readonly startedAt?: number;
  /** Run end timestamp, from the terminal event. */
  readonly finishedAt?: number;
  readonly status: "running" | "finished" | "cancelled" | "failed";
  readonly error?: string;
  /** The Run's pull request URL, once opened — surfaced on the final line. */
  readonly prUrl?: string;
  /** The interaction blocking the Run, awaiting a human decision; cleared on the terminal event. */
  readonly pendingInteraction?: PendingInteraction;
  /** Bounded cross-Step recent activity for a global live strip. */
  readonly globalActivity: readonly ActivityEntry[];

  // --- Active-Step live buffers, consumed by the append-only terminal renderer. ---
  // These mirror the active Step only and reset on each `step:started`; they are not a
  // whole-Run transcript. The TUI uses the per-Step `activity`/`currentTool` instead.
  /** The active step's coalesced assistant text (the renderer decides how to wrap/flush). */
  readonly text: string;
  /** The active step's current tool, set on `start` and cleared on `end`. */
  readonly tool?: ToolView;
  /** The active step's `ctx.log` messages, reset per step — shown live, and dumped on failure. */
  readonly logs: string[];
}

/** Activity-trail bounds: counts are capped, and a coalesced text entry keeps only its tail. */
const STEP_ACTIVITY_MAX = 200;
const GLOBAL_ACTIVITY_MAX = 500;
const ACTIVITY_TEXT_MAX = 4000;

/** The empty starting state, before any event has been folded in. */
export const initialView: ViewState = {
  steps: [],
  status: "running",
  globalActivity: [],
  text: "",
  logs: [],
};

/** Keep only the trailing `max` characters of `text` (bounds a coalesced text entry). */
function clampTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/**
 * Append `entry` to a bounded activity trail. Consecutive text entries for the same Step coalesce
 * into one (so token-by-token streaming does not flood the buffer), and the list is capped at `max`.
 */
function appendActivity(
  list: readonly ActivityEntry[],
  entry: ActivityEntry,
  max: number,
): ActivityEntry[] {
  const last = list[list.length - 1];
  if (entry.kind === "text" && last?.kind === "text" && last.step === entry.step) {
    const merged: ActivityEntry = {
      ...last,
      text: clampTail((last.text ?? "") + (entry.text ?? ""), ACTIVITY_TEXT_MAX),
      at: entry.at,
    };
    return [...list.slice(0, -1), merged];
  }
  // A lone text entry is bounded too, so a single huge delta cannot grow the trail unboundedly.
  const bounded =
    entry.kind === "text" && entry.text !== undefined
      ? { ...entry, text: clampTail(entry.text, ACTIVITY_TEXT_MAX) }
      : entry;
  const next = [...list, bounded];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Return a copy of `steps` with `name` mapped through `fn` (other steps untouched). */
function mapStep(steps: StepView[], name: string, fn: (step: StepView) => StepView): StepView[] {
  return steps.map((step) => (step.name === name ? fn(step) : step));
}

/** The findings of the latest recorded Round (highest index) for a Step. */
function latestFindings(rounds: readonly RoundRecord[]): Finding[] {
  if (rounds.length === 0) return [];
  const latest = rounds.reduce((a, b) => (b.index > a.index ? b : a));
  return [...latest.findings];
}

/**
 * Close the most recent still-active phase matching `label` + `group`. Matching the last active one
 * (not the first) is correct when a phase label recurs across rounds, or a tainted pass reruns. If
 * none matches (a stray finish) the list is returned unchanged.
 */
function resolvePhase(
  phases: readonly PhaseView[],
  phaseId: string | undefined,
  label: string,
  group: string | undefined,
  status: "ok" | "error",
  findings: Finding[],
  at: number,
): PhaseView[] {
  const index = phases.reduceRight((found, phase, i) => {
    if (found !== -1 || phase.status !== "active") return found;
    if (phaseId !== undefined) return phase.phaseId === phaseId ? i : found;
    return phase.label === label && phase.group === group ? i : found;
  }, -1);
  if (index === -1) return [...phases];
  return phases.map((phase, i) =>
    i === index
      ? {
          ...phase,
          status: status === "ok" ? "done" : "failed",
          findings: [...findings],
          finishedAt: at,
        }
      : phase,
  );
}

/** Fold one event into both the named Step's activity and the global activity trail. */
function recordActivity(view: ViewState, step: string, entry: ActivityEntry): ViewState {
  return {
    ...view,
    steps: mapStep(view.steps, step, (s) => ({
      ...s,
      activity: appendActivity(s.activity, entry, STEP_ACTIVITY_MAX),
    })),
    globalActivity: appendActivity(view.globalActivity, entry, GLOBAL_ACTIVITY_MAX),
  };
}

/** Fold the time a Step spent blocked on a now-resolved interaction into its `waitedMs`. */
function accumulateWait(view: ViewState, pending: PendingInteraction, at: number): ViewState {
  const waited = Math.max(0, at - pending.at);
  if (waited === 0) return view;
  return {
    ...view,
    steps: mapStep(view.steps, pending.step, (s) => ({
      ...s,
      waitedMs: (s.waitedMs ?? 0) + waited,
    })),
  };
}

export function present(view: ViewState, event: RunEvent): ViewState {
  // The Run is blocked while an interaction is pending, so the next event of any other kind means
  // that interaction resolved. Fold the blocked spell into the waiting Step's `waitedMs` *before*
  // reducing - so any duration the reducer stamps (e.g. on `step:finished`) already excludes it -
  // then clear the interaction. Terminal events also clear it in their own branch.
  const pending = view.pendingInteraction;
  const resolved =
    pending !== undefined && event.type !== "ask:pending" && event.type !== "approval:pending";
  const next = reduce(resolved ? accumulateWait(view, pending, event.at) : view, event);
  return resolved && next.pendingInteraction !== undefined
    ? { ...next, pendingInteraction: undefined }
    : next;
}

function reduce(view: ViewState, event: RunEvent): ViewState {
  switch (event.type) {
    case "run:started":
      return {
        ...view,
        startedAt: event.at,
        steps: event.pipeline.map((name) => ({
          name,
          status: "pending",
          artifacts: [],
          rounds: [],
          findings: [],
          activity: [],
          phases: [],
        })),
      };
    case "step:started":
      // Flip the step to active, stamp its start, and reset the active-step live buffers.
      return {
        ...view,
        steps: mapStep(view.steps, event.step, (s) => ({
          ...s,
          status: "active",
          startedAt: event.at,
        })),
        activeStep: event.step,
        text: "",
        tool: undefined,
        logs: [],
      };
    case "agent:progress": {
      if (event.progress.kind === "text") {
        const next = recordActivity(view, event.step, {
          at: event.at,
          step: event.step,
          kind: "text",
          text: event.progress.text,
        });
        return { ...next, text: next.text + event.progress.text }; // coalesce deltas (active step)
      }
      // A tool start sets the activity line; a tool end clears it.
      const tool =
        event.progress.phase === "start"
          ? { name: event.progress.name, detail: event.progress.detail }
          : undefined;
      const next = recordActivity(view, event.step, {
        at: event.at,
        step: event.step,
        kind: "tool",
        tool: { name: event.progress.name, detail: event.progress.detail },
        phase: event.progress.phase,
      });
      return {
        ...next,
        steps: mapStep(next.steps, event.step, (s) => ({ ...s, currentTool: tool })),
        tool,
      };
    }
    case "step:finished":
      return {
        ...view,
        steps: mapStep(view.steps, event.step, (s) => ({
          ...s,
          status: "done",
          finishedAt: event.at,
          ...(s.startedAt !== undefined
            ? { durationMs: Math.max(0, event.at - s.startedAt - (s.waitedMs ?? 0)) }
            : {}),
          currentTool: undefined,
        })),
        activeStep: undefined,
        tool: undefined,
      };
    case "step:skipped":
      return {
        ...view,
        steps: mapStep(view.steps, event.step, (s) => ({
          ...s,
          status: "skipped",
          finishedAt: event.at,
          currentTool: undefined,
        })),
        activeStep: undefined,
        tool: undefined,
      };
    case "run:finished":
      return {
        ...view,
        status: "finished",
        finishedAt: event.at,
        activeStep: undefined,
        tool: undefined,
        pendingInteraction: undefined,
      };
    case "run:cancelled":
      return {
        ...view,
        status: "cancelled",
        finishedAt: event.at,
        activeStep: undefined,
        tool: undefined,
        pendingInteraction: undefined,
      };
    case "run:failed":
      // Mark the failing step (or the active one) failed so renderers can show ✗.
      return {
        ...view,
        steps: mapStep(view.steps, event.step ?? view.activeStep ?? "", (s) => ({
          ...s,
          status: "failed",
          finishedAt: event.at,
          ...(s.startedAt !== undefined
            ? { durationMs: Math.max(0, event.at - s.startedAt - (s.waitedMs ?? 0)) }
            : {}),
          error: event.error,
          currentTool: undefined,
        })),
        status: "failed",
        finishedAt: event.at,
        error: event.error,
        tool: undefined,
        pendingInteraction: undefined,
      };
    case "pr:opened":
      return { ...view, prUrl: event.url };
    case "step:log": {
      // A step's log line — appended to the active-step buffer and the bounded activity trails.
      const next = recordActivity(view, event.step, {
        at: event.at,
        step: event.step,
        kind: "log",
        text: event.message,
      });
      return { ...next, logs: [...next.logs, event.message] };
    }
    case "artifact:written": {
      // Record every artifact; the first string artifact a step produces also becomes its headline
      // (declared order decides — e.g. describe's `prTitle` wins over `prBody`). Non-string
      // artifacts carry no `rendered`; objects like the PullRequest surface via `pr:opened`.
      const { artifact, rendered, at } = event;
      return {
        ...view,
        steps: mapStep(view.steps, event.step, (s) => ({
          ...s,
          artifacts: [
            ...s.artifacts,
            { name: artifact, at, ...(rendered !== undefined ? { rendered } : {}) },
          ],
          ...(s.headline === undefined && rendered !== undefined ? { headline: rendered } : {}),
        })),
      };
    }
    case "round:recorded": {
      // Record the Round and refresh the Step's current findings (latest round wins).
      const { round } = event;
      return {
        ...view,
        steps: mapStep(view.steps, event.step, (s) => {
          const rounds = [...s.rounds, round];
          return { ...s, rounds, findings: latestFindings(rounds) };
        }),
      };
    }
    case "phase:started": {
      // Append a new active phase. Phases accumulate across rounds; `group` distinguishes them.
      const phase: PhaseView = {
        phaseId: event.phaseId,
        label: event.phase,
        ...(event.group !== undefined ? { group: event.group } : {}),
        status: "active",
        findings: [],
        startedAt: event.at,
      };
      return {
        ...view,
        steps: mapStep(view.steps, event.step, (s) => ({ ...s, phases: [...s.phases, phase] })),
      };
    }
    case "phase:finished":
      // Resolve the most recent matching active phase (label + group); attach its findings.
      return {
        ...view,
        steps: mapStep(view.steps, event.step, (s) => ({
          ...s,
          phases: resolvePhase(
            s.phases,
            event.phaseId,
            event.phase,
            event.group,
            event.status,
            event.findings,
            event.at,
          ),
        })),
      };
    case "ask:pending":
      // The prompt blocks the Run awaiting input; presenters surface it from `pendingInteraction`.
      return {
        ...view,
        pendingInteraction: { kind: "ask", step: event.step, prompt: event.prompt, at: event.at },
      };
    case "approval:pending":
      return {
        ...view,
        pendingInteraction: {
          kind: "approval",
          step: event.step,
          input: event.input,
          at: event.at,
        },
      };
  }
}
