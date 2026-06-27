---
"@tml/view": minor
---

Restyle the TUI: a transparent base (the terminal's own background now shows through the header, footer, pipeline rail, step inspector, and activity panel) with Catppuccin Mocha accents. All color now flows from a single semantic theme module (`theme.ts`) instead of hardcoded hex scattered across the components. Blocking overlays (the interaction drawer, help, and abort confirmation) keep an opaque surface fill so they read cleanly when they overlap the panels behind them. The plain (`--plain`/non-TTY) renderer is unchanged - it stays on basic ANSI so it keeps adapting to the user's own terminal palette.
