---
"tml": minor
"@tml/view": patch
---

Make running the pipeline the default command: `tml` (no subcommand) now runs the pipeline on the current checkout, with all the former ship options (`--verbose`, `--plain`, `--resume`, `--fresh`). `tml ship` keeps working as an alias but is no longer required or advertised - the help text and the TUI banner now read `tml`.
