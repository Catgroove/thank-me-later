import { describe, expect, test } from "bun:test";
import type { RunEvent, RunEventInput } from "@tml/core";
import { initialView, present, type ViewState } from "../src/present.ts";
import type { Renderer } from "../src/renderer.ts";
import {
  attachThrough,
  type EventSource,
  foldEvents,
  isTerminalEvent,
  replayThrough,
} from "../src/viewer.ts";

const stamp = (event: RunEventInput, i: number): RunEvent => ({ ...event, at: i }) as RunEvent;
const fold = (events: RunEventInput[]): ViewState =>
  events.reduce<ViewState>((v, e, i) => present(v, stamp(e, i)), initialView);

const SEQUENCE: RunEvent[] = [
  { type: "run:started", at: 0, pipeline: ["produce"] },
  { type: "step:started", at: 1, step: "produce" },
  { type: "pr:opened", at: 2, url: "https://example/pull/7" },
  { type: "step:finished", at: 3, step: "produce" },
  { type: "run:finished", at: 4 },
];

/** A renderer that records the views it was handed and the lifecycle calls it received. */
function recordingRenderer(): Renderer & {
  views: ViewState[];
  completed: boolean;
  closed: boolean;
} {
  const state = { views: [] as ViewState[], completed: false, closed: false };
  return {
    ...state,
    render(view: ViewState): void {
      this.views.push(view);
    },
    complete(): void {
      this.completed = true;
    },
    close(): void {
      this.closed = true;
    },
  };
}

describe("viewer", () => {
  test("foldEvents reproduces the same ViewState as the live fold", () => {
    expect(foldEvents(SEQUENCE)).toEqual(fold(SEQUENCE));
  });

  test("isTerminalEvent flags the run-ending events", () => {
    expect(isTerminalEvent({ type: "run:finished", at: 0 })).toBe(true);
    expect(isTerminalEvent({ type: "run:failed", at: 0, error: "x" })).toBe(true);
    expect(isTerminalEvent({ type: "run:cancelled", at: 0 })).toBe(true);
    expect(isTerminalEvent({ type: "step:started", at: 0, step: "s" })).toBe(false);
  });

  test("replayThrough renders every event and completes with the final view", async () => {
    const renderer = recordingRenderer();
    const final = await replayThrough(renderer, SEQUENCE);
    expect(renderer.views).toHaveLength(SEQUENCE.length);
    expect(renderer.completed).toBe(true);
    expect(final.status).toBe("finished");
    expect(final.prUrl).toBe("https://example/pull/7");
  });

  test("attachThrough follows appended events and stops at the terminal event", async () => {
    // The source grows by one event per read, simulating a live run appending to events.jsonl.
    let revealed = 2;
    const source: EventSource = {
      read: async () => {
        const slice = SEQUENCE.slice(0, revealed);
        revealed = Math.min(revealed + 1, SEQUENCE.length);
        return slice;
      },
    };
    const renderer = recordingRenderer();
    let waits = 0;
    const final = await attachThrough(renderer, source, { wait: async () => void waits++ });

    expect(final.status).toBe("finished");
    expect(renderer.completed).toBe(true);
    // Each source event was rendered exactly once, despite re-reads handing back the whole prefix.
    expect(renderer.views).toHaveLength(SEQUENCE.length);
    expect(waits).toBeGreaterThan(0);
  });

  test("attachThrough stops early when the viewer detaches", async () => {
    const source: EventSource = {
      read: async () => SEQUENCE.slice(0, 2), // never reaches a terminal event
    };
    const renderer = recordingRenderer();
    let detached = false;
    const final = await attachThrough(renderer, source, {
      wait: async () => {
        detached = true; // detach after the first poll
      },
      detached: () => detached,
    });
    expect(final.status).toBe("running");
    expect(renderer.completed).toBe(true);
  });
});
