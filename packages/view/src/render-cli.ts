// TTY renderer: a scroll-safe live region over `ViewState` (ADR-0011). Each step opens
// with a `▸ <name>` header; its activity commits to scrollback underneath it as it happens
// — coalesced prose and one `⚙ <tool> · <detail>` line per command — and the step closes
// with `✓ <name>  (<elapsed>)`. The fold stays pure and clockless; this owns the clock and
// ANSI. The layout mirrors the plain renderer's, so both modes read alike.
//
// The hard rule that keeps this correct under `tmux` scroll and terminal resize: the only
// mutable surface is the *single bottom line* the cursor sits on. We never move the cursor
// up (`\x1b[A`). A live region that floats above committed content needs relative cursor
// movement, and that math desyncs the instant the viewport scrolls under us (the cursor is
// our only position reference) — which smears spinner frames into scrollback. So instead:
//   1. Permanent lines are *appended* (`<line>\n`) and scroll into history untouched, the
//      way any normal program's output does — inherently scroll- and resize-safe.
//   2. The live line is rewritten in place with `\r` (column 0) + `\x1b[2K` (clear *that*
//      line) only — no vertical movement, so scrolling can't desync it.
//   3. Streaming prose can't live in a multi-line floating region, so it rides the live
//      line: completed wrapped lines seal into scrollback as they fill (greedy wrap makes
//      every line but the last final), and only the volatile last line stays live, with the
//      spinner trailing it. When there's no pending prose the live line is a bare spinner.
//   4. Every frame is wrapped in synchronized output (DEC 2026, `?2026h`/`l`) so it paints
//      atomically; the cursor is hidden while a live line is up and shown on close.
//
// This trades away the original separate spinner-on-its-own-line below streaming prose: a
// multi-line live region needs vertical movement (or opentui's native scroll-region/footer
// machinery), which we don't want here. The one residual rough edge is a terminal *resize*
// mid-stream: already-committed lines stay wrapped at the old width (cosmetic), and the
// in-flight prose run may re-wrap — never a cursor smear, just a possible reflow seam.
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
const SPINNER_RESERVE = 2; // room the trailing " <spinner>" needs on the live line

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

  // The single live line currently on screen — the cursor sits on it. "" means none.
  let lastLive = "";
  // The active step's prose run: `runStart` is where the current run begins in `view.text`
  // (advanced past each committed tool's text), `proseCommitted` counts how many of the
  // run's wrapped lines have already sealed into scrollback. Both reset on step start.
  let runStart = 0;
  let proseCommitted = 0;
  let frame = 0;
  let stepStart: number | undefined;
  let anyStep = false; // a blank line separates each step from the previous one
  let lastView: ViewState | undefined;
  let cursorHidden = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Truncate to the terminal width so a line can't soft-wrap and break the single-line math. */
  function clip(line: string): string {
    const width = termColumns();
    return line.length > width ? line.slice(0, width) : line;
  }

  /** Content width for prose, leaving room for the indent and the trailing spinner. */
  function wrapWidth(): number {
    return Math.max(1, Math.min(termColumns(), MAX_WIDTH) - BODY_INDENT.length - SPINNER_RESERVE);
  }

  /** The current prose run (from `runStart`) wrapped to the body width. */
  function wrapRun(view: ViewState): string[] {
    return wrap(view.text.slice(runStart), wrapWidth(), BODY_INDENT);
  }

  /** The single live line for `view`: the volatile last prose line + spinner, or a bare spinner. */
  function liveLine(view: ViewState): string {
    if (view.status !== "running" || view.activeStep === undefined) return "";
    const spinner = glyphs.frames[frame % glyphs.frames.length];
    const wrapped = wrapRun(view);
    const tail = wrapped.length > 0 ? wrapped[wrapped.length - 1] : "";
    return clip(tail === "" ? `${BODY_INDENT}${spinner}` : `${tail} ${spinner}`);
  }

  /**
   * Append `permanent` lines to scrollback (a header, sealed prose, a command, a result), then
   * redraw the single live line — one atomic sync'd write. The live line is wiped with `\r` +
   * clear-line and rewritten in place; permanent lines reuse that row and scroll up with `\n`.
   * No vertical cursor movement, so tmux scroll / resize can't desync us.
   */
  function paint(permanent: string[], live: string): void {
    if (permanent.length === 0 && live === lastLive) return; // nothing changed
    let out = SYNC_ON;
    if (!cursorHidden) {
      out += HIDE_CURSOR;
      cursorHidden = true;
    }
    out += `\r${CLEAR_LINE}`; // wipe the current live line; permanent content reuses its row
    for (const line of permanent) out += `${clip(line)}\n`;
    out += clip(live); // the new live line — cursor stays on it, no trailing newline
    out += SYNC_OFF;
    write(out);
    lastLive = live;
  }

  /** Redraw just the live line (spinner tick / streaming text); skips when unchanged. */
  function paintLive(view: ViewState): void {
    lastView = view;
    paint([], liveLine(view));
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
      paintLive(lastView); // only the spinner glyph differs → the live line is rewritten
    }, intervalMs);
    // Don't keep the process alive solely for the spinner.
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    render(view: ViewState, event: RunEvent): void {
      lastView = view;
      switch (event.type) {
        case "run:started":
          paint([`▶ ${event.pipeline.join(" → ")}`], liveLine(view));
          return;
        case "step:started": {
          stepStart = now();
          runStart = 0;
          proseCommitted = 0;
          const header = `${STEP_INDENT}${glyphs.started} ${event.step}`;
          paint(anyStep ? ["", header] : [header], liveLine(view));
          anyStep = true;
          return;
        }
        case "agent:progress": {
          if (event.progress.kind === "tool" && event.progress.phase === "start") {
            // Commit any prose that preceded the command (incl. the volatile last line, now
            // final) plus the ⚙ line, then start a fresh prose run past this text — the agent
            // may keep talking, and a new run keeps wrapping independent of committed lines.
            const { name, detail } = event.progress;
            const remaining = wrapRun(view).slice(proseCommitted);
            const toolLine = `${BODY_INDENT}${glyphs.tool} ${name}${detail ? ` · ${detail}` : ""}`;
            runStart = view.text.length;
            proseCommitted = 0;
            paint([...remaining, toolLine], liveLine(view));
          } else if (event.progress.kind === "text") {
            // Greedy wrap makes every line but the last final: seal those into scrollback and
            // keep the last one live. Most deltas only grow the last line → just repaint it.
            const wrapped = wrapRun(view);
            const sealUpto = Math.max(0, wrapped.length - 1);
            const newlySealed = wrapped.slice(proseCommitted, sealUpto);
            if (newlySealed.length > 0) {
              proseCommitted = sealUpto;
              paint(newlySealed, liveLine(view));
            } else {
              paintLive(view);
            }
          } else {
            paintLive(view); // tool end carries nothing to show
          }
          return;
        }
        case "step:finished": {
          const remaining = wrapRun(view).slice(proseCommitted);
          proseCommitted += remaining.length;
          paint(
            [...remaining, `${STEP_INDENT}${glyphs.done} ${event.step}${elapsed()}`],
            liveLine(view),
          );
          return;
        }
        case "step:skipped": {
          const remaining = wrapRun(view).slice(proseCommitted);
          proseCommitted += remaining.length;
          paint(
            [...remaining, `${STEP_INDENT}${glyphs.skipped} ${event.step} (skipped)`],
            liveLine(view),
          );
          return;
        }
        case "run:finished":
          stopTimer();
          paint([...wrapRun(view).slice(proseCommitted), "■ run finished"], "");
          showCursor();
          return;
        case "run:cancelled":
          stopTimer();
          paint(
            [
              ...wrapRun(view).slice(proseCommitted),
              `◼ run cancelled${event.step ? ` at ${event.step}` : ""}`,
            ],
            "",
          );
          showCursor();
          return;
        case "run:failed":
          stopTimer();
          paint(
            [
              ...wrapRun(view).slice(proseCommitted),
              `${glyphs.failed} run failed${event.step ? ` at ${event.step}` : ""}: ${event.error}`,
            ],
            "",
          );
          showCursor();
          return;
        case "step:log":
        case "artifact:written":
        case "ask:pending":
          return; // no live-line change in v1
      }
    },
    close(): void {
      stopTimer();
      if (lastLive !== "") paint([], ""); // erase a half-drawn live line on abort
      showCursor();
    },
  };
}
