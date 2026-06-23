// @tml/view — the shared presentation layer: a pure fold from core's
// `RunEvent` stream into a `ViewState`, plus one terminal output module that draws it. The CLI
// renders it now, the OpenTUI TUI next, host Adapters later — all consume the *same*
// fold, so they cannot drift. No presentation logic lives in `@tml/core`;
// this package peer-depends on core and imports only its public `RunEvent`.

export { initialView, present, type StepView, type ToolView, type ViewState } from "./present.ts";
export type { Renderer } from "./renderer.ts";
export { createTerminalRenderer, type TerminalRendererOptions } from "./render-terminal.ts";
