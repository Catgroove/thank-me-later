// TTY renderer: a scroll-safe live region over `ViewState`, results-forward by default.
//
// Quiet mode (the default) separates signal from noise. While a step runs, its agent chatter,
// tool calls, and log lines ride the *transient* live line — a spinner + the active step name +
// whatever is happening right now — and are then discarded. Only durable content seals into
// scrollback: each step's result line (`✓ <step>  <artifact>  (<elapsed>)`), an end-of-run
// results block (the narrative artifacts + the PR URL), and — on failure — the failing step's
// retained trail so the user can see what broke. Verbose mode (`--verbose`) instead seals the
// full trail as it happens (a `▸ <step>` header, prose, `⚙` tool lines, `· log` lines), which is
// what every run used to do.
//
// The hard rule that keeps this correct under `tmux` scroll and terminal resize: the only mutable
// surface is the *single bottom line* the cursor sits on. We never move the cursor up (`\x1b[A`).
// A live region that floats above committed content needs relative cursor movement, and that math
// desyncs the instant the viewport scrolls under us — smearing frames into scrollback. So instead:
//   1. Permanent lines are *appended* (`<line>\n`) and scroll into history untouched, the way any
//      normal program's output does — inherently scroll- and resize-safe.
//   2. The live line is rewritten in place with `\r` (column 0) + `\x1b[2K` (clear *that* line)
//      only — no vertical movement, so scrolling can't desync it.
//   3. Quiet mode never seals mid-stream, so the live line is the sole churn. Verbose mode seals
//      completed wrapped prose lines as they fill (greedy wrap makes every line but the last
//      final) and keeps only the volatile last line live, with the spinner trailing it.
//   4. Every frame is wrapped in synchronized output (DEC 2026, `?2026h`/`l`) so it paints
//      atomically; the cursor is hidden while a live line is up and shown on close.
//
// Color (dim for transient/structural lines, bold/green/red/cyan for results and outcomes) is an
// SGR overlay gated on `color`; `clip` measures visible width so codes never break the single-line
// math. `ship()` only constructs this when `process.stdout.isTTY`; a dumb terminal (no `TERM`)
// still gets the ASCII glyph set and no color.

import type { RunEvent } from "@tml/core";
import type { StepView, ViewState } from "./present.ts";
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
  readonly rule: string;
}
const UNICODE: Glyphs = {
  frames: BRAILLE,
  started: "▸",
  done: "✓",
  failed: "✗",
  skipped: "⤼",
  tool: "⚙",
  rule: "─",
};
const DUMB: Glyphs = {
  frames: ASCII,
  started: ">",
  done: "[ok]",
  failed: "[x]",
  skipped: "[-]",
  tool: "*",
  rule: "-",
};

export interface CliRendererOptions {
  readonly write?: (chunk: string) => void;
  readonly columns?: number;
  readonly term?: string | undefined;
  readonly now?: () => number;
  /** Spinner animation interval in ms; 0 disables the timer (tests). */
  readonly intervalMs?: number;
  /** Seal the full per-step trail instead of discarding it (the `--verbose` flag). */
  readonly verbose?: boolean;
  /** ANSI color/hierarchy; defaults to on for a real, color-capable TTY. */
  readonly color?: boolean;
}

const MAX_WIDTH = 100;
const STEP_INDENT = "  "; // step headers / results / the results block
const BODY_INDENT = "    "; // a step's commands, prose, and failure dump
const LABEL_WIDTH = 8; // the results block's left label gutter
const SPINNER_RESERVE = 2; // room the trailing " <spinner>" needs on the live line
const RESULTS_HEAD = "results "; // after the two leading rule glyphs
const INLINE_MAX = 56; // a longer (or multi-line) artifact is narrative — it goes to the block

/** A long or multi-line artifact reads as narrative: shown in the results block, not inline. */
function isNarrative(rendered: string): boolean {
  return rendered.includes("\n") || rendered.length > INLINE_MAX;
}

const ESC = "\x1b";

// Length of the SGR escape sequence (`ESC [ … m`) starting at `i`, or 0 if none does. Used to
// step over zero-width color codes when measuring/truncating by visible columns — a manual scan
// instead of a regex, which can't carry a control character.
function sgrAt(line: string, i: number): number {
  if (line[i] !== ESC || line[i + 1] !== "[") return 0;
  let j = i + 2;
  while (j < line.length && line[j] !== "m") {
    const c = line[j] ?? "";
    if (c !== ";" && (c < "0" || c > "9")) return 0; // not an SGR sequence after all
    j += 1;
  }
  return j < line.length ? j - i + 1 : 0; // include the trailing `m`
}

export function createCliRenderer(options: CliRendererOptions = {}): Renderer {
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 80;
  const term = options.term ?? process.env.TERM;
  const glyphs = term === "dumb" ? DUMB : UNICODE;
  const verbose = options.verbose ?? false;
  const color =
    options.color ??
    (term !== "dumb" && process.env.NO_COLOR === undefined && !!process.stdout.isTTY);
  const termColumns = (): number => options.columns ?? process.stdout.columns ?? 80;

  // SGR helpers — identities when color is off, so plain output (and tests) is untouched.
  const sgr = (codes: string, s: string): string => (color ? `\x1b[${codes}m${s}\x1b[0m` : s);
  const dim = (s: string): string => sgr("2", s);
  const bold = (s: string): string => sgr("1", s);
  const red = (s: string): string => sgr("31", s);
  const green = (s: string): string => sgr("32", s);
  const cyan = (s: string): string => sgr("36", s);

  // The single live line currently on screen — the cursor sits on it. "" means none.
  let lastLive = "";
  // Verbose-only: absolute offset into the active step's `view.text` up to which prose has sealed
  // into scrollback. The still-live tail is rewrapped from here, so a resize only affects
  // uncommitted text. Quiet mode never seals prose, so this stays 0.
  let proseCommittedLen = 0;
  let frame = 0;
  let stepStart: number | undefined;
  let anyStep = false; // verbose: a blank line separates each step's header from the previous one
  let lastView: ViewState | undefined;
  let cursorHidden = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function visibleLen(line: string): number {
    let n = 0;
    for (let i = 0; i < line.length; ) {
      const len = sgrAt(line, i);
      if (len > 0) i += len;
      else {
        n += 1;
        i += 1;
      }
    }
    return n;
  }

  /** Truncate to the terminal's visible width (ignoring SGR codes) so a line can't soft-wrap. */
  function clip(line: string): string {
    const width = termColumns();
    if (visibleLen(line) <= width) return line;
    let out = "";
    let shown = 0;
    for (let i = 0; i < line.length; ) {
      const len = sgrAt(line, i);
      if (len > 0) {
        out += line.slice(i, i + len);
        i += len;
        continue;
      }
      if (shown >= width) break;
      out += line[i];
      shown += 1;
      i += 1;
    }
    if (out.includes(ESC)) out += `${ESC}[0m`; // close any SGR left open by truncation
    return out;
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
   * Wrap prose on spaces while keeping source offsets for each rendered line. Offsets let verbose
   * mode seal completed lines by character position instead of by wrapped-line count, so a resize
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

  /** Wrap `text` to `width`, returning the bare wrapped segments (no indent). */
  function wrap(text: string, width: number): string[] {
    return wrapWithOffsets(text, width, "").map((entry) => entry.line);
  }

  /** Verbose: the not-yet-sealed prose tail wrapped to the current body width. */
  function pendingProse(view: ViewState): WrappedLine[] {
    return wrapWithOffsets(
      view.text.slice(proseCommittedLen),
      wrapWidth(),
      BODY_INDENT,
      proseCommittedLen,
    );
  }

  /** Verbose: mark all currently pending prose as committed (used at hard boundaries). */
  function commitPendingProse(view: ViewState): string[] {
    const pending = pendingProse(view).map((entry) => dim(entry.line));
    proseCommittedLen = view.text.length;
    return pending;
  }

  /** The current activity for the quiet live line: the tool, else the prose tail, else the log. */
  function activityTail(view: ViewState): string {
    if (view.tool !== undefined) {
      const { name, detail } = view.tool;
      return `${glyphs.tool} ${name}${detail !== undefined ? ` · ${detail}` : ""}`;
    }
    const prose = view.text
      .split("\n")
      .map((segment) => segment.trim())
      .filter((segment) => segment !== "");
    return prose.at(-1) ?? view.logs.at(-1) ?? "";
  }

  /** The single live line for `view` — the active step + its current activity, with a spinner. */
  function liveLine(view: ViewState): string {
    if (view.status !== "running" || view.activeStep === undefined) return "";
    const spinner = glyphs.frames[frame % glyphs.frames.length];
    if (verbose) {
      const wrapped = pendingProse(view);
      const tail = wrapped.length > 0 ? (wrapped[wrapped.length - 1]?.line ?? "") : "";
      return clip(tail === "" ? `${BODY_INDENT}${spinner}` : `${tail} ${spinner}`);
    }
    const head = `${STEP_INDENT}${spinner} ${view.activeStep}`;
    const activity = activityTail(view);
    return clip(activity === "" ? head : `${head}  ${dim(activity)}`);
  }

  /**
   * Append `permanent` lines to scrollback, then redraw the single live line — one atomic sync'd
   * write. The live line is wiped with `\r` + clear-line and rewritten in place; permanent lines
   * reuse that row and scroll up with `\n`. No vertical cursor movement.
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

  /** Redraw just the live line (spinner tick / streaming activity); skips when unchanged. */
  function paintLive(view: ViewState): void {
    lastView = view;
    paint([], liveLine(view));
  }

  function elapsed(): string {
    if (stepStart === undefined) return "";
    const secs = Math.max(0, Math.round((now() - stepStart) / 1000));
    return `  (${secs}s)`;
  }

  /** A step's sealed result line: a short artifact inline, dimmed when the step produced none. */
  function stepResult(view: ViewState, name: string): string {
    const rendered = view.steps.find((step) => step.name === name)?.rendered;
    if (rendered === undefined) {
      // No artifact (a check, a commit) — structural, so de-emphasize it.
      return dim(`${STEP_INDENT}${glyphs.done} ${name}${elapsed()}`);
    }
    // Narrative artifacts go to the results block in full; only short ones read inline here.
    const inline = isNarrative(rendered) ? "" : `  ${rendered}`;
    return `${STEP_INDENT}${green(glyphs.done)} ${name}${inline}${dim(elapsed())}`;
  }

  /** The end-of-run results block: narrative artifacts (in full) + the PR URL. */
  function resultsBlock(view: ViewState): string[] {
    const narrative = view.steps.filter(
      (step): step is StepView & { rendered: string } =>
        step.rendered !== undefined && isNarrative(step.rendered),
    );
    if (narrative.length === 0 && view.prUrl === undefined) return [];
    const lines: string[] = [];
    const head = `${glyphs.rule}${glyphs.rule} ${RESULTS_HEAD}`;
    const fill = Math.max(0, Math.min(termColumns(), MAX_WIDTH) - STEP_INDENT.length - head.length);
    lines.push(dim(`${STEP_INDENT}${head}${glyphs.rule.repeat(fill)}`));
    const gutter = STEP_INDENT.length + LABEL_WIDTH;
    const cont = " ".repeat(gutter);
    const width = Math.max(1, Math.min(termColumns(), MAX_WIDTH) - gutter);
    for (const step of narrative) {
      const label = `${STEP_INDENT}${step.name.padEnd(LABEL_WIDTH)}`;
      wrap(step.rendered, width).forEach((segment, i) =>
        lines.push((i === 0 ? label : cont) + segment),
      );
    }
    if (view.prUrl !== undefined)
      lines.push(`${STEP_INDENT}${"pr".padEnd(LABEL_WIDTH)}${cyan(view.prUrl)}`);
    return lines;
  }

  /** Quiet: the failing step's retained prose + logs, dimmed, dumped so the user sees the cause. */
  function failureDump(view: ViewState): string[] {
    const lines = wrap(view.text, wrapWidth()).map((segment) => dim(`${BODY_INDENT}${segment}`));
    for (const log of view.logs) lines.push(dim(`${BODY_INDENT}· ${log}`));
    return lines;
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
      // The PR link, appended to a cancelled/failed run-end line (those have no results block).
      const prSuffix = view.prUrl !== undefined ? ` · ${cyan(view.prUrl)}` : "";
      // Verbose seals the prose tail at every hard boundary; quiet discarded it as it streamed.
      const sealed = (): string[] => (verbose ? commitPendingProse(view) : []);
      switch (event.type) {
        case "run:started": {
          const header = bold("▶ ship");
          // Verbose lists the pipeline upfront; quiet lets each step announce itself live.
          const permanent = verbose
            ? [header, ...event.pipeline.map((step) => `${STEP_INDENT}${step}`)]
            : [header];
          paint(permanent, liveLine(view));
          return;
        }
        case "step:started": {
          stepStart = now();
          proseCommittedLen = 0;
          if (verbose) {
            const header = `${STEP_INDENT}${glyphs.started} ${event.step}`;
            paint(anyStep ? ["", header] : [header], liveLine(view));
            anyStep = true;
          } else {
            paintLive(view); // the live line now shows the new active step
          }
          return;
        }
        case "agent:progress": {
          if (!verbose) {
            paintLive(view); // chatter and tools ride the transient live line
            return;
          }
          if (event.progress.kind === "tool" && event.progress.phase === "start") {
            // Commit any prose that preceded the command (incl. the volatile last line, now final)
            // plus the ⚙ line, then start a fresh prose run past this text.
            const { name, detail } = event.progress;
            const remaining = commitPendingProse(view);
            const toolLine = dim(
              `${BODY_INDENT}${glyphs.tool} ${name}${detail !== undefined ? ` · ${detail}` : ""}`,
            );
            paint([...remaining, toolLine], liveLine(view));
          } else if (event.progress.kind === "text") {
            // Greedy wrap makes every line but the last final: seal those, keep the last one live.
            const wrapped = pendingProse(view);
            const newlySealed = wrapped.slice(0, -1);
            if (newlySealed.length > 0) {
              proseCommittedLen = newlySealed[newlySealed.length - 1]?.end ?? proseCommittedLen;
              paint(
                newlySealed.map((entry) => dim(entry.line)),
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
        case "step:log":
          // A step's log line: transient in quiet mode, sealed (dimmed) in verbose.
          if (verbose) paint([dim(`${BODY_INDENT}· ${event.message}`)], liveLine(view));
          else paintLive(view);
          return;
        case "step:finished":
          paint([...sealed(), stepResult(view, event.step)], liveLine(view));
          return;
        case "step:skipped":
          paint(
            [...sealed(), dim(`${STEP_INDENT}${glyphs.skipped} ${event.step} (skipped)`)],
            liveLine(view),
          );
          return;
        case "ask:pending":
          // The prompt blocks the Run awaiting input, so it must seal — it can't be transient.
          paint([...sealed(), `${STEP_INDENT}? ${event.step}: ${event.prompt}`], liveLine(view));
          return;
        case "run:finished":
          stopTimer();
          paint([...sealed(), ...resultsBlock(view), "■ run finished"], "");
          showCursor();
          return;
        case "run:cancelled":
          stopTimer();
          paint(
            [...sealed(), `◼ run cancelled${event.step ? ` at ${event.step}` : ""}${prSuffix}`],
            "",
          );
          showCursor();
          return;
        case "run:failed": {
          stopTimer();
          const failedStep = event.step ?? view.activeStep;
          // Quiet discarded the trail as it streamed — dump the failing step's so the cause shows.
          const dump =
            !verbose && failedStep !== undefined && failedStep === view.activeStep
              ? [`${STEP_INDENT}${red(glyphs.failed)} ${failedStep}`, ...failureDump(view)]
              : [];
          const line =
            red(
              `${glyphs.failed} run failed${event.step ? ` at ${event.step}` : ""}: ${event.error}`,
            ) + prSuffix;
          paint([...sealed(), ...dump, line], "");
          showCursor();
          return;
        }
        case "pr:opened": // held in view.prUrl; surfaced in the results block / run-end line
          return;
      }
    },
    close(): void {
      stopTimer();
      if (lastLive !== "") paint([], ""); // erase a half-drawn live line on abort
      showCursor();
    },
  };
}
