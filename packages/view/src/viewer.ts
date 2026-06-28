// The read-only viewer: it reconstructs a Run from its persisted event stream and drives a Renderer,
// never an engine. Because presentation is a pure fold, a finished Run's outcome and a live Run's
// progress are the same artifact seen two ways - `replayThrough` folds a complete stream once,
// `attachThrough` folds a growing one until it reaches a terminal event. No responders, no mutation.

import type { RunEvent } from "@tml/core";
import { initialView, present, type ViewState } from "./present.ts";
import type { Renderer } from "./renderer.ts";

/** Fold a recorded event sequence into the final `ViewState`, exactly as the live fold would. */
export function foldEvents(events: readonly RunEvent[]): ViewState {
  return events.reduce<ViewState>((view, event) => present(view, event), initialView);
}

/** Whether an event ends the Run. The attach loop stops once one arrives. */
export function isTerminalEvent(event: RunEvent): boolean {
  return (
    event.type === "run:finished" || event.type === "run:failed" || event.type === "run:cancelled"
  );
}

/** Replay a complete event stream through a renderer as a read-only view, then complete it. */
export async function replayThrough(
  renderer: Renderer,
  events: readonly RunEvent[],
): Promise<ViewState> {
  let view = initialView;
  for (const event of events) {
    view = present(view, event);
    renderer.render(view, event);
  }
  await renderer.complete?.(view);
  return view;
}

/** Reads whatever events a Run has recorded so far. The attach loop re-reads it as the Run grows. */
export interface EventSource {
  read(): Promise<RunEvent[]>;
}

export interface AttachOptions {
  /** Wait before re-reading the source. Injected by tests; the CLI sleeps `pollMs`. */
  readonly wait: () => Promise<void>;
  /** Set when the viewer is dismissed (detached) so the loop stops following. */
  readonly detached?: () => boolean;
}

/**
 * Follow a live Run: fold what exists, then re-read and fold appended events until a terminal event
 * arrives or the viewer is detached. Renders incrementally so the dashboard tracks the Run.
 */
export async function attachThrough(
  renderer: Renderer,
  source: EventSource,
  opts: AttachOptions,
): Promise<ViewState> {
  let view = initialView;
  let consumed = 0;
  for (;;) {
    const events = await source.read();
    for (let i = consumed; i < events.length; i += 1) {
      const event = events[i];
      if (event === undefined) continue;
      view = present(view, event);
      renderer.render(view, event);
      if (isTerminalEvent(event)) {
        await renderer.complete?.(view);
        return view;
      }
    }
    consumed = events.length;
    if (opts.detached?.()) break;
    await opts.wait();
  }
  await renderer.complete?.(view);
  return view;
}
