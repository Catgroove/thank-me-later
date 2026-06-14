import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@tml/core";
import { initialView, present } from "../src/present.ts";
import { createPlainRenderer } from "../src/render-plain.ts";

/** Drive a sequence through the fold + plain renderer, collecting the emitted lines. */
function renderLines(events: RunEvent[]): string[] {
  const lines: string[] = [];
  const renderer = createPlainRenderer((line) => lines.push(line));
  let view = initialView;
  for (const event of events) {
    view = present(view, event);
    renderer.render(view, event);
  }
  renderer.close();
  return lines;
}

describe("createPlainRenderer", () => {
  test("emits clean append-only lines: transitions, one tool line, coalesced prose", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["format", "lint"] },
      { type: "step:started", step: "format" },
      { type: "agent:progress", step: "format", progress: { kind: "text", text: "Running " } },
      {
        type: "agent:progress",
        step: "format",
        progress: { kind: "text", text: "the formatter." },
      },
      {
        type: "agent:progress",
        step: "format",
        progress: { kind: "tool", name: "bash", phase: "start", detail: "bun run fmt" },
      },
      {
        type: "agent:progress",
        step: "format",
        progress: { kind: "tool", name: "bash", phase: "end" },
      },
      { type: "step:finished", step: "format" },
      { type: "step:started", step: "lint" },
      { type: "step:skipped", step: "lint" },
      { type: "run:finished" },
    ]);

    expect(lines).toEqual([
      "▶ run started:",
      "  format",
      "  lint",
      "  ▸ format",
      "    Running the formatter.", // coalesced, flushed at the tool boundary
      "    ⚙ bash · bun run fmt",
      "  ✓ format",
      "  ▸ lint",
      "  ⤼ lint (skipped)",
      "■ run finished",
    ]);
  });

  test("never emits a line per text delta (no token spam)", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["x"] },
      { type: "step:started", step: "x" },
      { type: "agent:progress", step: "x", progress: { kind: "text", text: "a" } },
      { type: "agent:progress", step: "x", progress: { kind: "text", text: "b" } },
      { type: "agent:progress", step: "x", progress: { kind: "text", text: "c" } },
      { type: "step:finished", step: "x" },
    ]);
    expect(lines).toEqual(["▶ run started:", "  x", "  ▸ x", "    abc", "  ✓ x"]);
  });

  test("flushes text between consecutive tools, never re-printing earlier prose", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["x"] },
      { type: "step:started", step: "x" },
      { type: "agent:progress", step: "x", progress: { kind: "text", text: "first." } },
      {
        type: "agent:progress",
        step: "x",
        progress: { kind: "tool", name: "read", phase: "start", detail: "a.ts" },
      },
      { type: "agent:progress", step: "x", progress: { kind: "tool", name: "read", phase: "end" } },
      { type: "agent:progress", step: "x", progress: { kind: "text", text: " second." } },
      {
        type: "agent:progress",
        step: "x",
        progress: { kind: "tool", name: "read", phase: "start", detail: "b.ts" },
      },
      { type: "step:finished", step: "x" },
    ]);
    expect(lines).toEqual([
      "▶ run started:",
      "  x",
      "  ▸ x",
      "    first.",
      "    ⚙ read · a.ts",
      "    second.",
      "    ⚙ read · b.ts",
      "  ✓ x",
    ]);
  });

  test("reports a failure with its step and error", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["test"] },
      { type: "step:started", step: "test" },
      { type: "run:failed", step: "test", error: "boom" },
    ]);
    expect(lines.at(-1)).toBe("✗ run failed at test: boom");
  });
});
