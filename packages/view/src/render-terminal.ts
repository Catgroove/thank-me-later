// The single terminal output module. One implementation, two mechanics selected by `plain`:
//
//   - TTY (default): a scroll-safe live region. Quiet mode keeps agent chatter on one transient
//     bottom line and appends only durable content to scrollback; verbose seals the full per-step
//     trail. The live region never moves the cursor up - permanent lines append with `\n`, and the
//     single live line is rewritten with `\r` + clear line, so tmux scroll and resize can't desync
//     it. SGR color is optional; `clip` measures visible width so ANSI codes never break the math.
//
//   - plain (pipes, CI): append-only. There is no live region, so structure is always sealed - the
//     pipeline list and `▸` step headers stand in for the missing transient line. Falls out of the
//     same code as the TTY path with the live line suppressed, color off, and width unbounded: with
//     nothing to wrap and nothing kept live, the prose/results machinery seals every line straight
//     to the sink.
//
// Both paths share every content decision - artifact surfacing, the results block, prompts, and the
// run-ending lines - so a future host adapter inherits one policy instead of copying a third.

import type { RunEvent } from "@tml/core";
import { approvalPrompt, isNarrativeArtifact, narrativeSteps, resultLabelWidth } from "./format.ts";
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

export interface TerminalRendererOptions {
  /** Raw output sink. The TTY path writes ANSI chunks; the plain path writes `<line>\n`. */
  readonly write?: (chunk: string) => void;
  /** Append-only mechanics for a non-TTY sink (pipes, CI): no live line, no color, no wrap. */
  readonly plain?: boolean;
  readonly columns?: number;
  readonly term?: string | undefined;
  readonly now?: () => number;
  /** Spinner animation interval in ms; 0 disables the timer (tests). Ignored when `plain`. */
  readonly intervalMs?: number;
  /** Seal the full per-step trail instead of discarding it (the `--verbose` flag). */
  readonly verbose?: boolean;
  /** ANSI color/hierarchy; defaults to on for a real, color-capable TTY. Forced off when `plain`. */
  readonly color?: boolean;
}

const MAX_WIDTH = 100;
const STEP_INDENT = "  "; // step headers / results / the results block
const BODY_INDENT = "    "; // a step's commands, prose, and failure dump
const SPINNER_RESERVE = 2; // room the trailing " <spinner>" needs on the live line
const RESULTS_HEAD = "results "; // after the two leading rule glyphs
const PLAIN_RULE_FILL = 20; // the results-rule length when there is no terminal width to fill

const ESC = "\x1b";

// Length of the SGR escape sequence (`ESC [ … m`) starting at `i`, or 0 if none does. Used to
// step over zero-width color codes when measuring/truncating by visible columns - a manual scan
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

export function createTerminalRenderer(options: TerminalRendererOptions = {}): Renderer {
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const plain = options.plain ?? false;
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 80;
  const term = options.term ?? process.env.TERM;
  const dumb = term === undefined || term === "" || term === "dumb";
  // Plain output is for pipes/CI: always the unicode glyph set, the ASCII fallback is a TTY concern.
  const glyphs = plain || !dumb ? UNICODE : DUMB;
  const verbose = options.verbose ?? false;
  const color = plain
    ? false
    : (options.color ?? (!dumb && process.env.NO_COLOR === undefined && !!process.stdout.isTTY));
  const termColumns = (): number => options.columns ?? process.stdout.columns ?? 80;
  // With no live region, the pipeline list and `▸` step headers carry the structure the transient
  // line would otherwise show. Verbose seals that trail too, so both share this flag.
  const trail = plain || verbose;

  // SGR helpers - identities when color is off, so plain output (and tests) is untouched.
  const sgr = (codes: string, s: string): string => (color ? `\x1b[${codes}m${s}\x1b[0m` : s);
  const dim = (s: string): string => sgr("2", s);
  const bold = (s: string): string => sgr("1", s);
  const red = (s: string): string => sgr("31", s);
  const green = (s: string): string => sgr("32", s);
  const cyan = (s: string): string => sgr("36", s);

  // The single live line currently on screen - the cursor sits on it. "" means none. Plain never
  // draws one, so this stays "".
  let lastLive = "";
  // Verbose-only: absolute offset into the active step's `view.text` up to which prose has sealed
  // into scrollback. The still-live tail is rewrapped from here, so a resize only affects
  // uncommitted text. Quiet mode never seals prose, so this stays 0.
  let proseCommittedLen = 0;
  let frame = 0;
  let stepStart: number | undefined;
  let anyStep = false; // verbose TTY: a blank line separates each step's header from the previous
  let lastView: ViewState | undefined;
  let cursorHidden = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pausedForInput = false;

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
    if (plain) return Number.POSITIVE_INFINITY; // append-only: let the terminal wrap, never us
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
   * cannot make future rewraps skip or duplicate prose that was already committed. An infinite
   * width (plain) only ever breaks on newlines, so it degrades to one rendered line per source line.
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

  /** The single live line for `view` - the active step + its current activity, with a spinner. */
  function liveLine(view: ViewState): string {
    if (plain || view.status !== "running" || view.activeStep === undefined) return "";
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
   * Seal `permanent` lines and redraw the live line. The TTY path wipes the live line with `\r` +
   * clear-line and rewrites it in place in one atomic sync'd write, scrolling permanent content up
   * with `\n` and no vertical cursor movement. The plain path has no live region: it writes each
   * permanent line straight to the sink and ignores `live`.
   */
  function commit(permanent: string[], live: string): void {
    if (plain) {
      for (const line of permanent) write(`${line}\n`);
      return;
    }
    if (permanent.length === 0 && live === lastLive) return; // nothing changed
    let out = SYNC_ON;
    if (!cursorHidden) {
      out += HIDE_CURSOR;
      cursorHidden = true;
    }
    out += `\r${CLEAR_LINE}`; // wipe the current live line; permanent content reuses its row
    for (const line of permanent) out += `${clip(line)}\n`;
    out += clip(live); // the new live line - cursor stays on it, no trailing newline
    out += SYNC_OFF;
    write(out);
    lastLive = live;
  }

  /** Redraw just the live line (spinner tick / streaming activity); a no-op under `plain`. */
  function paintLive(view: ViewState): void {
    lastView = view;
    commit([], liveLine(view));
  }

  function elapsed(): string {
    if (plain || stepStart === undefined) return ""; // append-only output omits timings
    const secs = Math.max(0, Math.round((now() - stepStart) / 1000));
    return `  (${secs}s)`;
  }

  /** A step's sealed result line: a short artifact inline, dimmed when the step produced none. */
  function stepResult(view: ViewState, name: string): string {
    const rendered = view.steps.find((step) => step.name === name)?.headline;
    if (rendered === undefined) {
      // No artifact (a check, a commit) - structural, so de-emphasize it.
      return dim(`${STEP_INDENT}${glyphs.done} ${name}${elapsed()}`);
    }
    // Narrative artifacts go to the results block in full; only short ones read inline here.
    const inline = isNarrativeArtifact(rendered) ? "" : `  ${rendered}`;
    return `${STEP_INDENT}${green(glyphs.done)} ${name}${inline}${dim(elapsed())}`;
  }

  /** The end-of-run results block: narrative artifacts (in full) + the PR URL. */
  function resultsBlock(view: ViewState): string[] {
    const narrative = narrativeSteps(view);
    if (narrative.length === 0 && view.prUrl === undefined) return [];
    const lines: string[] = [];
    const head = `${glyphs.rule}${glyphs.rule} ${RESULTS_HEAD}`;
    const fill = plain
      ? PLAIN_RULE_FILL
      : Math.max(0, Math.min(termColumns(), MAX_WIDTH) - STEP_INDENT.length - head.length);
    lines.push(dim(`${STEP_INDENT}${head}${glyphs.rule.repeat(fill)}`));
    const labelWidth = resultLabelWidth(narrative, view.prUrl !== undefined);
    const gutter = STEP_INDENT.length + labelWidth;
    const cont = " ".repeat(gutter);
    const width = plain
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.min(termColumns(), MAX_WIDTH) - gutter);
    for (const step of narrative) {
      const label = `${STEP_INDENT}${step.name.padEnd(labelWidth)}`;
      wrap(step.headline, width).forEach((segment, i) =>
        lines.push((i === 0 ? label : cont) + segment),
      );
    }
    if (view.prUrl !== undefined)
      lines.push(`${STEP_INDENT}${"pr".padEnd(labelWidth)}${cyan(view.prUrl)}`);
    return lines;
  }

  /** Quiet TTY: the failing step's retained prose + logs, dimmed, so the user sees the cause. */
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

  if (!plain && intervalMs > 0) {
    timer = setInterval(() => {
      if (
        pausedForInput ||
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
      if (event.type !== "ask:pending" && event.type !== "approval:pending") {
        pausedForInput = false;
      }
      switch (event.type) {
        case "run:started": {
          const header = bold("▶ ship");
          // A sealed trail lists the pipeline upfront; the quiet live line lets each step announce
          // itself instead.
          const permanent = trail
            ? [header, ...event.pipeline.map((step) => `${STEP_INDENT}${step}`)]
            : [header];
          commit(permanent, liveLine(view));
          return;
        }
        case "step:started": {
          stepStart = now();
          proseCommittedLen = 0;
          if (trail) {
            const header = `${STEP_INDENT}${glyphs.started} ${event.step}`;
            // The live verbose trail spaces steps apart; append-only output keeps them flush.
            const separated = !plain && verbose && anyStep ? ["", header] : [header];
            commit(separated, liveLine(view));
            anyStep = true;
          } else {
            paintLive(view); // the live line now shows the new active step
          }
          return;
        }
        case "agent:progress": {
          if (!verbose) {
            paintLive(view); // quiet TTY: chatter rides the live line; plain drops it
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
            commit([...remaining, toolLine], liveLine(view));
          } else if (event.progress.kind === "text") {
            // Greedy wrap makes every line but the last final: seal those, keep the last one live.
            // Plain has no last-line-live, so the boundary commits flush everything.
            const wrapped = pendingProse(view);
            const newlySealed = wrapped.slice(0, -1);
            if (newlySealed.length > 0) {
              proseCommittedLen = newlySealed[newlySealed.length - 1]?.end ?? proseCommittedLen;
              commit(
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
          // A step's log line: transient on the quiet live line, sealed (dimmed) on a trail.
          if (trail) commit([...sealed(), dim(`${BODY_INDENT}· ${event.message}`)], liveLine(view));
          else paintLive(view);
          return;
        case "step:finished":
          commit([...sealed(), stepResult(view, event.step)], liveLine(view));
          return;
        case "step:skipped":
          commit(
            [...sealed(), dim(`${STEP_INDENT}${glyphs.skipped} ${event.step} (skipped)`)],
            liveLine(view),
          );
          return;
        case "ask:pending":
          // The prompt blocks the Run awaiting input, so it must seal - it can't be transient.
          // Leave no spinner/live line behind: readline owns the terminal until input resolves.
          pausedForInput = true;
          commit([...sealed(), `${STEP_INDENT}? ${event.step}: ${event.prompt}`], "");
          showCursor();
          return;
        case "approval:pending":
          // Structured approval blocks the Run the same way, but carries findings for a UI.
          // Leave no spinner/live line behind: readline owns the terminal until input resolves.
          pausedForInput = true;
          commit([...sealed(), `${STEP_INDENT}? ${event.step}: ${approvalPrompt(event)}`], "");
          showCursor();
          return;
        case "run:finished":
          stopTimer();
          commit([...sealed(), ...resultsBlock(view), "■ run finished"], "");
          showCursor();
          return;
        case "run:cancelled":
          stopTimer();
          commit(
            [...sealed(), `◼ run cancelled${event.step ? ` at ${event.step}` : ""}${prSuffix}`],
            "",
          );
          showCursor();
          return;
        case "run:failed": {
          stopTimer();
          const failedStep = event.step ?? view.activeStep;
          // The quiet TTY discarded the trail as it streamed - dump the failing step's so the cause
          // shows. A sealed trail already has it; plain quiet never retained prose, so neither dump.
          const dump =
            !trail && failedStep !== undefined && failedStep === view.activeStep
              ? [`${STEP_INDENT}${red(glyphs.failed)} ${failedStep}`, ...failureDump(view)]
              : [];
          const line =
            red(
              `${glyphs.failed} run failed${event.step ? ` at ${event.step}` : ""}: ${event.error}`,
            ) + prSuffix;
          commit([...sealed(), ...dump, line], "");
          showCursor();
          return;
        }
        case "pr:opened": // held in view.prUrl; surfaced in the results block / run-end line
        case "artifact:written": // surfaced on the step's result line and the results block
        case "phase:started": // folded into the step's phases; the append-only CLI rides the live line
        case "phase:finished":
          return;
      }
    },
    close(): void {
      stopTimer();
      if (lastLive !== "") commit([], ""); // erase a half-drawn live line on abort (TTY only)
      showCursor();
    },
  };
}
