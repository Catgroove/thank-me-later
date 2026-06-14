import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@tml/core";
import { initialView, present } from "../src/present.ts";
import { type CliRendererOptions, createCliRenderer } from "../src/render-cli.ts";

/** Drive a sequence through the fold + TTY renderer, capturing the raw chunks written. */
function renderRaw(events: RunEvent[], options: Partial<CliRendererOptions> = {}): string {
  let out = "";
  const renderer = createCliRenderer({
    write: (chunk) => {
      out += chunk;
    },
    columns: 80,
    term: "xterm",
    intervalMs: 0, // no animation timer in tests
    now: () => 0,
    ...options,
  });
  let view = initialView;
  for (const event of events) {
    view = present(view, event);
    renderer.render(view, event);
  }
  renderer.close();
  return out;
}

const HAPPY: RunEvent[] = [
  { type: "run:started", pipeline: ["format", "lint"] },
  { type: "step:started", step: "format" },
  {
    type: "agent:progress",
    step: "format",
    progress: { kind: "text", text: "Running the formatter now." },
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
];

describe("createCliRenderer", () => {
  test("renders a full sequence without throwing and commits finished steps", () => {
    const out = renderRaw(HAPPY);
    expect(out).toContain("✓ format");
    expect(out).toContain("⤼ lint (skipped)");
    expect(out).toContain("■ run finished");
    // The active step's prose appears, and the command is committed as its own ⚙ line.
    expect(out).toContain("Running the formatter now.");
    expect(out).toContain("⚙ bash · bun run fmt");
    // A Braille spinner frame is used in a normal terminal.
    expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  test("heads the step, commits each command, and keeps the spinner bare", () => {
    const out = renderRaw([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
      {
        type: "agent:progress",
        step: "lint",
        progress: { kind: "tool", name: "bash", phase: "start", detail: "bun run lint" },
      },
      {
        type: "agent:progress",
        step: "lint",
        progress: { kind: "tool", name: "bash", phase: "end" },
      },
      {
        type: "agent:progress",
        step: "lint",
        progress: { kind: "tool", name: "read", phase: "start", detail: "src/index.ts" },
      },
    ]);
    // The step name heads its block; the commands commit beneath it as permanent ⚙ lines.
    expect(out).toContain("▸ lint");
    expect(out).toContain("⚙ bash · bun run lint");
    expect(out).toContain("⚙ read · src/index.ts");
    // The spinner is a bare liveness indicator — the step name lives on the header, not here.
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] lint/);
  });

  test("separates steps with a blank line, but not before the first", () => {
    const out = renderRaw([
      { type: "run:started", pipeline: ["branch", "lint"] },
      { type: "step:started", step: "branch" },
      { type: "step:finished", step: "branch" },
      { type: "step:started", step: "lint" },
      { type: "step:finished", step: "lint" },
      { type: "run:finished" },
    ]);
    // The second header is preceded by a committed blank line; the first is not.
    const blankBefore = (name: string) => `\x1b[2K\n\r\x1b[2K  ▸ ${name}`;
    expect(out).toContain(blankBefore("lint"));
    expect(out).not.toContain(blankBefore("branch"));
  });

  test("emits ANSI cursor control for the live region", () => {
    const out = renderRaw(HAPPY);
    // biome-ignore lint: explicit ESC for the clear-region sequence.
    expect(out).toContain("\x1b[");
  });

  test("shows elapsed time on a committed step", () => {
    // step:started reads the clock (0); the commit on step:finished reads it again (3000).
    const stamps = [0, 3000];
    let i = 0;
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["test"] },
        { type: "step:started", step: "test" },
        { type: "step:finished", step: "test" },
        { type: "run:finished" },
      ],
      { now: () => stamps[Math.min(i++, stamps.length - 1)] ?? 0 },
    );
    expect(out).toContain("✓ test  (3s)");
  });

  test("falls back to an ASCII glyph set on a dumb terminal", () => {
    const out = renderRaw(HAPPY, { term: "dumb" });
    expect(out).toContain("[ok] format");
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});
