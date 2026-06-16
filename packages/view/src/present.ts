// The presenter — a pure reducer that folds the engine's fine-grained event stream
// into a `ViewState`. No I/O, no clock, no ANSI: elapsed
// time and drawing are the renderers' concern. The CLI renders it now, the TUI next,
// Adapters later — all share this fold, so they cannot drift. It mirrors the engine's
// other reducers: a `switch (event.type)` returning a new state, never mutating input.

import type { RunEvent } from "@tml/core";

export interface StepView {
  readonly name: string;
  readonly status: "pending" | "active" | "done" | "skipped" | "failed";
}

/** Current tool activity, with a short human label (e.g. bash → the command). */
export interface ToolView {
  readonly name: string;
  readonly detail?: string;
}

export interface ViewState {
  /** Steps in pipeline order, seeded from `run:started`. */
  readonly steps: StepView[];
  /** The name of the step currently running, or undefined between/after steps. */
  readonly activeStep?: string;
  /** The active step's coalesced assistant text (the renderer decides how to wrap/flush). */
  readonly text: string;
  /** The current tool, set on `start` and cleared on `end`; v1 keeps only the latest. */
  readonly tool?: ToolView;
  readonly status: "running" | "finished" | "cancelled" | "failed";
  readonly error?: string;
}

/** The empty starting state, before any event has been folded in. */
export const initialView: ViewState = { steps: [], text: "", status: "running" };

/** Return a copy of `steps` with `name` set to `status` (others untouched). */
function setStatus(steps: StepView[], name: string, status: StepView["status"]): StepView[] {
  return steps.map((step) => (step.name === name ? { name: step.name, status } : step));
}

export function present(view: ViewState, event: RunEvent): ViewState {
  switch (event.type) {
    case "run:started":
      return {
        ...view,
        steps: event.pipeline.map((name) => ({ name, status: "pending" })),
      };
    case "step:started":
      // Flip the step to active and reset the per-step buffers.
      return {
        ...view,
        steps: setStatus(view.steps, event.step, "active"),
        activeStep: event.step,
        text: "",
        tool: undefined,
      };
    case "agent:progress":
      if (event.progress.kind === "text") {
        return { ...view, text: view.text + event.progress.text }; // coalesce deltas
      }
      // A tool start sets the activity line; a tool end clears it.
      return {
        ...view,
        tool:
          event.progress.phase === "start"
            ? { name: event.progress.name, detail: event.progress.detail }
            : undefined,
      };
    case "step:finished":
      return {
        ...view,
        steps: setStatus(view.steps, event.step, "done"),
        activeStep: undefined,
        tool: undefined,
      };
    case "step:skipped":
      return {
        ...view,
        steps: setStatus(view.steps, event.step, "skipped"),
        activeStep: undefined,
        tool: undefined,
      };
    case "run:finished":
      return { ...view, status: "finished", activeStep: undefined, tool: undefined };
    case "run:cancelled":
      return { ...view, status: "cancelled", tool: undefined };
    case "run:failed":
      // Mark the failing step (or the active one) failed so renderers can show ✗.
      return {
        ...view,
        steps: setStatus(view.steps, event.step ?? view.activeStep ?? "", "failed"),
        status: "failed",
        error: event.error,
        tool: undefined,
      };
    case "step:log":
    case "artifact:written":
    case "ask:pending":
      // Carry no display state in v1 (current-tool + coalesced prose only).
      return view;
  }
}
