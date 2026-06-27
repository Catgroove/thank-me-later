// @tml/view - the shared presentation layer: a pure fold from core's
// `RunEvent` stream into a `ViewState`, terminal/TUI renderers, and renderer-agnostic helpers
// such as `openSystemUrl`. The CLI, TUI, and host Adapters all consume the *same* fold, so they
// cannot drift. No presentation logic lives in `@tml/core`; this package peer-depends on core and
// imports only its public `RunEvent`.

export { openSystemUrl } from "./open-url.ts";
export { initialView, present, type ViewState } from "./present.ts";
export type { InteractiveRenderer, Renderer } from "./renderer.ts";
export { failingApproveResponder, failingAskResponder } from "./responders.ts";
export { createTerminalRenderer, type TerminalRendererOptions } from "./render-terminal.ts";
