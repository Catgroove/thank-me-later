// TTY renderer: a scroll-safe live region over `ViewState`. Each step opens
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
// non-TTY. A dumb terminal (no `TERM`) still gets the ASCII glyph set.

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

export function createCliRenderer(options: CliRendererOptions = {}): Renderer {
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 80;
  const term = options.term ?? process.env.TERM;
  const glyphs = term === "dumb" ? DUMB : UNICODE;
  const termColumns = (): number => options.columns ?? process.stdout.columns ?? 80;

  // The single live line currently on screen — the cursor sits on it. "" means none.
  let lastLive = "";
  // Absolute offset into the active step's `view.text` up to which prose has sealed into
  // scrollback. The still-live tail is rewrapped from here, so terminal resizes can only
  // affect uncommitted text; already-sealed text is never recomputed or duplicated.
  let proseCommittedLen = 0;
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

  interface WrappedLine {
    readonly line: string;
    /** Absolute source offset just after the last word rendered on this line. */
    readonly end: number;
  }

  /**
   * Wrap prose on spaces while keeping source offsets for each rendered line. Offsets let us
   * seal completed lines by character position instead of by wrapped-line count, so a resize
   * cannot make future rewraps skip or duplicate prose that was already committed.
   */
  function wrapWithOffsets(text: string, width: number, indent: string, base = 0): WrappedLine[] {
    const lines: WrappedLine[] = [];
    let paragraphStart = 0;
    for (const paragraph of text.split("\n")) {
      let line = "";
      let lineEnd = base + paragraphStart;
      for (const match of paragraph.matchAll(/\S+/g)) {
        const word = match[0];
        const wordEnd = base + paragraphStart + (match.index ?? 0) + word.length;
        if (line === "") {
          line = word;
          lineEnd = wordEnd;
        } else if (line.length + 1 + word.length <= width) {
          line += ` ${word}`;
          lineEnd = wordEnd;
        } else {
          lines.push({ line: indent + line, end: lineEnd });
          line = word;
          lineEnd = wordEnd;
        }
      }
      if (line !== "") lines.push({ line: indent + line, end: lineEnd });
      paragraphStart += paragraph.length + 1;
    }
    return lines;
  }

  /** The not-yet-sealed prose tail wrapped to the current body width. */
  function pendingProse(view: ViewState): WrappedLine[] {
    return wrapWithOffsets(
      view.text.slice(proseCommittedLen),
      wrapWidth(),
      BODY_INDENT,
      proseCommittedLen,
    );
  }

  /** Mark all currently pending prose as committed (used at hard boundaries). */
  function commitPendingProse(view: ViewState): string[] {
    const pending = pendingProse(view).map((entry) => entry.line);
    proseCommittedLen = view.text.length;
    return pending;
  }

  /** The single live line for `view`: the volatile last prose line + spinner, or a bare spinner. */
  function liveLine(view: ViewState): string {
    if (view.status !== "running" || view.activeStep === undefined) return "";
    const spinner = glyphs.frames[frame % glyphs.frames.length];
    const wrapped = pendingProse(view);
    const tail = wrapped.length > 0 ? (wrapped[wrapped.length - 1]?.line ?? "") : "";
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
          paint(
            ["▶ pipeline", ...event.pipeline.map((step) => `${STEP_INDENT}${step}`)],
            liveLine(view),
          );
          return;
        case "step:started": {
          stepStart = now();
          proseCommittedLen = 0;
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
            const remaining = commitPendingProse(view);
            const toolLine = `${BODY_INDENT}${glyphs.tool} ${name}${detail ? ` · ${detail}` : ""}`;
            paint([...remaining, toolLine], liveLine(view));
          } else if (event.progress.kind === "text") {
            // Greedy wrap makes every line but the last final: seal those into scrollback and
            // keep the last one live. Most deltas only grow the last line → just repaint it.
            const wrapped = pendingProse(view);
            const newlySealed = wrapped.slice(0, -1);
            if (newlySealed.length > 0) {
              proseCommittedLen = newlySealed[newlySealed.length - 1]?.end ?? proseCommittedLen;
              paint(
                newlySealed.map((entry) => entry.line),
                liveLine(view),
              );
            } else {
              paintLive(view);
            }
          } else {
            paintLive(view); // tool end carries nothing to show
          }
          return;
        }
        case "step:finished": {
          const remaining = commitPendingProse(view);
          paint(
            [...remaining, `${STEP_INDENT}${glyphs.done} ${event.step}${elapsed()}`],
            liveLine(view),
          );
          return;
        }
        case "step:skipped": {
          const remaining = commitPendingProse(view);
          paint(
            [...remaining, `${STEP_INDENT}${glyphs.skipped} ${event.step} (skipped)`],
            liveLine(view),
          );
          return;
        }
        case "run:finished":
          stopTimer();
          paint([...commitPendingProse(view), "■ run finished"], "");
          showCursor();
          return;
        case "run:cancelled":
          stopTimer();
          paint(
            [
              ...commitPendingProse(view),
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
              ...commitPendingProse(view),
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
