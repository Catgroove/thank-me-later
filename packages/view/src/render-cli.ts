// TTY renderer: a flicker-free live region over `ViewState` (ADR-0011). Each step opens
// with a `▸ <name>` header; its activity commits to scrollback underneath it as it happens
// — coalesced prose paragraphs and one `⚙ <tool> · <detail>` line per command — and the
// step closes with `✓ <name>  (<elapsed>)`. A bare spinner floats at the bottom as the
// liveness indicator while the step runs. The fold stays pure and clockless; this owns the
// clock and ANSI. The layout mirrors the plain renderer's, so both modes read alike.
//
// Anti-flicker, mirroring pi-mono's TUI differential renderer (and opentui/bubbletea/ink):
//   1. Every frame is wrapped in synchronized output (DEC 2026, `?2026h`/`l`) so the
//      terminal composites it atomically — no half-painted intermediate state.
//   2. The live tail is *diffed* line-by-line against what's on screen; an animation tick
//      rewrites only the changed spinner line and steps the cursor past unchanged prose.
//   3. A changed line is cleared with `\x1b[2K` (that one line), never the whole region.
//   4. One `write()` per frame; the cursor is hidden for the duration and shown on close.
//
// `ship()` only constructs this when `process.stdout.isTTY`; a spinner never reaches a
// non-TTY (ADR-0011). A dumb terminal (no `TERM`) still gets the ASCII glyph set.

import type { RunEvent } from "@tml/core";
import type { ViewState } from "./present.ts";
import type { Renderer } from "./renderer.ts";

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII = ["|", "/", "-", "\\"];

interface Glyphs {
  readonly frames: readonly string[];
  readonly started: string;
  readonly done: string;
  readonly failed: string;
  readonly skipped: string;
  readonly tool: string;
}
const UNICODE: Glyphs = {
  frames: BRAILLE,
  started: "▸",
  done: "✓",
  failed: "✗",
  skipped: "⤼",
  tool: "⚙",
};
const DUMB: Glyphs = {
  frames: ASCII,
  started: ">",
  done: "[ok]",
  failed: "[x]",
  skipped: "[-]",
  tool: "*",
};

export interface CliRendererOptions {
  readonly write?: (chunk: string) => void;
  readonly columns?: number;
  readonly term?: string | undefined;
  readonly now?: () => number;
  /** Spinner animation interval in ms; 0 disables the timer (tests). */
  readonly intervalMs?: number;
}

const MAX_WIDTH = 100;
const STEP_INDENT = "  "; // step headers / results
const BODY_INDENT = "    "; // a step's commands and prose

const up = (n: number): string => (n > 0 ? `\x1b[${n}A` : "");

/** Wrap `text` to `width` columns on spaces, prefixing each line with `indent`. */
function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        lines.push(indent + line);
        line = word;
      }
    }
    if (line !== "") lines.push(indent + line);
  }
  return lines;
}

export function createCliRenderer(options: CliRendererOptions = {}): Renderer {
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 80;
  const term = options.term ?? process.env.TERM;
  const glyphs = term === "dumb" ? DUMB : UNICODE;
  const termColumns = (): number => options.columns ?? process.stdout.columns ?? 80;

  // The lines currently on screen in the live tail. The cursor is parked at column 0 of
  // the line directly below it, so a repaint moves up `liveLines.length` rows.
  let liveLines: string[] = [];
  // How much of the active step's `view.text` has been committed to scrollback. Reset on
  // step start; advanced whenever prose is flushed (at a tool boundary or step end).
  let committedTextLen = 0;
  let frame = 0;
  let stepStart: number | undefined;
  let anyStep = false; // a blank line separates each step from the previous one
  let lastView: ViewState | undefined;
  let cursorHidden = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Truncate to the terminal width so a long line can't soft-wrap and break the row math. */
  function clip(line: string): string {
    const width = termColumns();
    return line.length > width ? line.slice(0, width) : line;
  }

  /** The not-yet-committed tail of the active step's prose, wrapped (or [] when there is none). */
  function pendingProse(view: ViewState): string[] {
    const tail = view.text.slice(committedTextLen).trim();
    if (tail === "") return [];
    return wrap(tail, Math.min(termColumns(), MAX_WIDTH) - BODY_INDENT.length, BODY_INDENT);
  }

  /** The live tail for `view`: streaming prose above a bare spinner, or [] when idle. */
  function liveLinesFor(view: ViewState): string[] {
    if (view.status !== "running" || view.activeStep === undefined) return [];
    const spinner = glyphs.frames[frame % glyphs.frames.length];
    return [...pendingProse(view), `${BODY_INDENT}${spinner}`];
  }

  /** Diff the live tail against the screen, rewriting only changed lines (one sync'd write). */
  function repaint(view: ViewState): void {
    lastView = view;
    const next = liveLinesFor(view);
    const prev = liveLines;
    if (prev.length === 0 && next.length === 0) return;

    let out = SYNC_ON;
    if (!cursorHidden) {
      out += HIDE_CURSOR;
      cursorHidden = true;
    }
    out += up(prev.length); // to the top of the live tail
    const rows = Math.max(prev.length, next.length);
    for (let i = 0; i < rows; i++) {
      out += "\r";
      if (i < next.length) {
        if (i >= prev.length || next[i] !== prev[i]) out += CLEAR_LINE + next[i];
        // unchanged: leave the line as-is (this is what kills the flicker)
      } else {
        out += CLEAR_LINE; // a now-surplus line from a taller previous frame
      }
      out += "\n"; // advance one row (creates a new row at the bottom when growing)
    }
    out += up(rows - next.length); // park below the new tail
    out += `\r${SYNC_OFF}`;
    write(out);
    liveLines = next;
  }

  /**
   * Commit `permanent` lines to scrollback (a header, prose, a command, a finished step),
   * then redraw `next` as the live tail — one atomic sync'd write. The committed lines scroll
   * up and are never touched again; the frequent animation/text path uses `repaint` instead.
   */
  function commit(permanent: string[], next: string[]): void {
    let out = SYNC_ON;
    if (!cursorHidden) {
      out += HIDE_CURSOR;
      cursorHidden = true;
    }
    out += up(liveLines.length);
    const rows = permanent.map(clip).concat(next);
    const total = Math.max(liveLines.length, rows.length);
    for (let i = 0; i < total; i++) {
      out += "\r";
      out += i < rows.length ? CLEAR_LINE + rows[i] : CLEAR_LINE;
      out += "\n";
    }
    out += up(total - rows.length);
    out += `\r${SYNC_OFF}`;
    write(out);
    liveLines = next;
  }

  function elapsed(): string {
    if (stepStart === undefined) return "";
    const secs = Math.max(0, Math.round((now() - stepStart) / 1000));
    return `  (${secs}s)`;
  }

  function showCursor(): void {
    if (cursorHidden) {
      write(SHOW_CURSOR);
      cursorHidden = false;
    }
  }

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      if (
        lastView === undefined ||
        lastView.status !== "running" ||
        lastView.activeStep === undefined
      ) {
        return;
      }
      frame += 1;
      repaint(lastView); // only the spinner line differs → only it is rewritten
    }, intervalMs);
    // Don't keep the process alive solely for the spinner.
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    render(view: ViewState, event: RunEvent): void {
      switch (event.type) {
        case "run:started":
          write(`▶ ${event.pipeline.join(" → ")}\n`);
          return;
        case "step:started": {
          stepStart = now();
          committedTextLen = 0;
          const header = `${STEP_INDENT}${glyphs.started} ${event.step}`;
          commit(anyStep ? ["", header] : [header], liveLinesFor(view));
          anyStep = true;
          return;
        }
        case "agent:progress": {
          // A command commits to scrollback (with any prose that preceded it) so it stays put;
          // text just updates the live tail. Tool `end` carries nothing to show.
          if (event.progress.kind === "tool" && event.progress.phase === "start") {
            const { name, detail } = event.progress;
            const prose = pendingProse(view);
            committedTextLen = view.text.length; // that prose is now committed
            commit(
              [...prose, `${BODY_INDENT}${glyphs.tool} ${name}${detail ? ` · ${detail}` : ""}`],
              liveLinesFor(view),
            );
          } else {
            repaint(view);
          }
          return;
        }
        case "step:finished": {
          const prose = pendingProse(view);
          committedTextLen = view.text.length;
          commit(
            [...prose, `${STEP_INDENT}${glyphs.done} ${event.step}${elapsed()}`],
            liveLinesFor(view),
          );
          return;
        }
        case "step:skipped":
          commit(
            [...pendingProse(view), `${STEP_INDENT}${glyphs.skipped} ${event.step} (skipped)`],
            liveLinesFor(view),
          );
          return;
        case "run:finished":
          stopTimer();
          commit([...pendingProse(view), "■ run finished"], []);
          showCursor();
          return;
        case "run:cancelled":
          stopTimer();
          commit(
            [...pendingProse(view), `◼ run cancelled${event.step ? ` at ${event.step}` : ""}`],
            [],
          );
          showCursor();
          return;
        case "run:failed":
          stopTimer();
          commit(
            [
              ...pendingProse(view),
              `${glyphs.failed} run failed${event.step ? ` at ${event.step}` : ""}: ${event.error}`,
            ],
            [],
          );
          showCursor();
          return;
        case "step:log":
        case "artifact:written":
        case "ask:pending":
          return; // no live-tail change in v1
      }
    },
    close(): void {
      stopTimer();
      if (liveLines.length > 0) commit([], []); // erase a half-drawn tail on abort
      showCursor();
    },
  };
}
