// The shared renderer shape. A renderer is fed each `(ViewState, RunEvent)` after the
// fold and draws; `close()` finalizes (stops the spinner timer, commits trailing output).
// Both the plain and TTY renderers implement this so `ship()` can pick one by `isTTY`.

import type { RunEvent } from "@tml/core";
import type { ViewState } from "./present.ts";

export interface Renderer {
  render(view: ViewState, event: RunEvent): void;
  close(): void;
}
