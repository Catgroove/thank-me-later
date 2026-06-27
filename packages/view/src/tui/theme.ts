// The single source of truth for TUI color. Components reference the semantic tokens below - never
// a raw hex - so the whole look lives here. The base is transparent: no token paints a full-area
// background, so the terminal's own background shows through. The only fills are functional
// highlights (a selected row, a focused item), which use Catppuccin `surface` colors.
//
// Accents are Catppuccin Mocha, tuned for dark terminals (the common case). Swapping flavor is a
// one-line change to `palette` below; the tokens and every component stay put.

/** Catppuccin Mocha. Raw named colors, used only to define the semantic tokens. */
const palette = {
  base: "#1e1e2e",
  surface0: "#313244",
  surface1: "#45475a",
  overlay0: "#6c7086",
  text: "#cdd6f4",
  subtext0: "#a6adc8",
  red: "#f38ba8",
  peach: "#fab387",
  green: "#a6e3a1",
  sky: "#89dceb",
  blue: "#89b4fa",
  mauve: "#cba6f7",
} as const;

import type { FindingDisposition } from "@tml/core";

export const theme = {
  // Text
  text: palette.text, // primary text
  textMuted: palette.subtext0, // secondary / labels
  textFaint: palette.overlay0, // dim / inactive / pending

  // Accents and status
  accent: palette.sky, // active step, active tab, links, headings
  success: palette.green, // done / fixed
  failed: palette.red, // failed / error
  waiting: palette.peach, // blocked on a human decision
  tool: palette.mauve, // tool activity
  info: palette.blue, // PR url / informational

  // Structure
  border: palette.surface1, // panel borders
  borderAccent: palette.sky, // emphasized border (help overlay)
  borderWarn: palette.peach, // interaction drawer
  borderError: palette.red, // abort confirmation

  // Modal surfaces - the in-flow chrome is transparent, but blocking overlays (the interaction
  // drawer, help, abort confirm) can overflow and overlap the panels behind them, so they need an
  // opaque fill or underlying glyphs bleed through their gaps.
  overlayBg: palette.surface0,

  // Highlights
  selectionBg: palette.surface0, // the selected rail row
  focusBg: palette.surface1, // the focused finding row
  focusFg: palette.text, // text on a focused row
  actionFocusBg: palette.peach, // the focused action button
  actionFocusFg: palette.base, // text on the focused action button

  /** Disposition accent, shared by the findings inspector and the approval drawer. */
  disposition: {
    blocker: palette.red,
    "should-fix": palette.peach,
    consider: palette.sky,
    nit: palette.subtext0,
  } satisfies Record<FindingDisposition, string>,
} as const;
