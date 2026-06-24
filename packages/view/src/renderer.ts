// The shared renderer shape. A renderer is fed each `(ViewState, RunEvent)` after the
// fold and draws; `close()` finalizes (stops the spinner timer, commits trailing output).
// Both the plain and TTY renderers implement this so `ship()` can pick one by `isTTY`.
//
// A renderer may *also* be interactive: an `InteractiveRenderer` supplies the engine's human
// responders (`ask`, `approveFindings`) and a post-close `epilogue`. `ship()` wires those into
// the engine when present, and falls back to clear failing responders when they are not. The
// engine stays the lifecycle owner; the renderer only provides these functions.

import type { ApprovalDecision, ApproveFindingsInput, RunEvent } from "@tml/core";
import type { ViewState } from "./present.ts";

export interface Renderer {
  render(view: ViewState, event: RunEvent): void;
  close(): void;
}

export interface InteractiveRenderer extends Renderer {
  /** Resolve a free-text `ctx.ask`. */
  ask?(prompt: string): Promise<string>;
  /** Resolve a structured `ctx.approveFindings`. */
  approveFindings?(input: ApproveFindingsInput): Promise<ApprovalDecision>;
  /**
   * Resolve once the user dismisses a completed Run (e.g. presses `q`). `ship()` awaits this after a
   * `finished`/`failed` Run so the full-screen TUI stays up - showing the PR link and final state -
   * until the human leaves, instead of tearing down the instant the pipeline ends. Renderers that
   * exit immediately (plain / non-TTY / CI) omit it, so those paths return as soon as the Run ends.
   */
  awaitDismissal?(): Promise<void>;
  /** Print a compact scrollback summary after the renderer has closed and torn down. */
  epilogue?(view: ViewState): void;
}
