---
"tml": minor
"@tml/view": patch
---

Add an `openInBrowser` knob to `tml.json` (default `false`). When set, `tml ship` opens the run's PR in your default browser when the run finishes or fails after opening one - the same action as pressing `o` in the TUI - so a hands-off run still surfaces the PR. It is best set in your global `~/.config/tml/tml.json`. The browser-opener is now shared (`openSystemUrl`, exported from `@tml/view`) by both the TUI keybind and the CLI lifecycle.
