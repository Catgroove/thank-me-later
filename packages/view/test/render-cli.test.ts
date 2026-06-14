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
    // The second header is preceded by a committed blank line (a bare `\n` after the
    // cleared live line); the first follows its cleared line immediately, with no blank.
    const blankBefore = (name: string) => `\x1b[2K\n  ▸ ${name}`;
    expect(out).toContain(blankBefore("lint"));
    expect(out).not.toContain(blankBefore("branch"));
  });

  test("streams prose on a single live line, sealing filled lines into scrollback", () => {
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["describe"] },
        { type: "step:started", step: "describe" },
        {
          type: "agent:progress",
          step: "describe",
          progress: { kind: "text", text: "alpha bravo charlie delta echo" },
        },
      ],
      { columns: 20 },
    );
    // Filled lines seal into scrollback (committed above)...
    expect(out).toContain("alpha bravo");
    expect(out).toContain("charlie delta");
    // ...and only the volatile last line stays live, with the spinner trailing it inline.
    expect(out).toMatch(/echo [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  test("never moves the cursor up — the live region is one line (tmux-/resize-safe)", () => {
    // The whole point of the rewrite: zero `\x1b[<n>A`, so a viewport scrolled under us
    // (tmux copy mode) or a resize can't desync the cursor and smear the live region.
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["describe", "lint"] },
        { type: "step:started", step: "describe" },
        {
          type: "agent:progress",
          step: "describe",
          progress: { kind: "text", text: "alpha bravo charlie delta echo foxtrot golf hotel" },
        },
        {
          type: "agent:progress",
          step: "describe",
          progress: { kind: "tool", name: "bash", phase: "start", detail: "git diff" },
        },
        {
          type: "agent:progress",
          step: "describe",
          progress: { kind: "text", text: "more words streamed after the tool call as well" },
        },
        { type: "step:finished", step: "describe" },
        { type: "step:started", step: "lint" },
        { type: "step:skipped", step: "lint" },
        { type: "run:finished" },
      ],
      { columns: 24 },
    );
    // Cursor-up is ESC `[` <optional digits> `A`; scan for it without a control char in a regex.
    const movesCursorUp = out.split("\x1b[").some((part) => /^[0-9]*A/.test(part));
    expect(movesCursorUp).toBe(false);
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
