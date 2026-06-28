// Pure logic for the Run picker: how a key moves the selection, and what selecting a Run should do
// by its state. The OpenTUI screen (RunList.tsx) is a thin shell over this; the CLI maps the
// resulting `PickerOutcome` onto resume (the engine) or the read-only viewer.

import { classifyLiveness, type RunMetadata } from "@tml/core";

/** What selecting a Run does. `resume` re-enters the engine; `view`/`attach` open the read-only viewer. */
export type RunAction = "view" | "resume" | "attach";

export type PickerOutcome =
  | { readonly kind: "quit" }
  | { readonly kind: "select"; readonly run: RunMetadata; readonly action: RunAction };

export interface PickerState {
  readonly index: number;
}

export const initialPicker: PickerState = { index: 0 };

/** Fold a navigation key into the selection. Out-of-range moves clamp; unknown keys pass through. */
export function pickerOnKey(state: PickerState, key: string, count: number): PickerState {
  const last = Math.max(0, count - 1);
  switch (key) {
    case "j":
    case "down":
      return { index: Math.min(state.index + 1, last) };
    case "k":
    case "up":
      return { index: Math.max(state.index - 1, 0) };
    case "g":
      return { index: 0 };
    case "G":
      return { index: last };
    default:
      return state;
  }
}

/**
 * The default action for a Run when the user presses enter: a finished Run is viewed; a Run still
 * progressing is attached to; an orphaned or parked (cancelled/failed) Run is resumed. A resume
 * whose Pipeline has since changed is rejected by the journal with a clear error - the picker does
 * not load config to pre-check.
 */
export function defaultAction(meta: RunMetadata, now: number): RunAction {
  if (meta.status === "finished") return "view";
  if (meta.status === "running") {
    return classifyLiveness(meta, { now }) === "orphaned" ? "resume" : "attach";
  }
  return "resume";
}
