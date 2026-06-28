---
"@tml/core": minor
"@tml/view": minor
"tml": minor
---

Run history, the run picker, the viewer, and a guided startup gate. `tml runs` (alias `tml ls`)
lists the recent runs for a checkout - a picker in a TTY, a plain table when piped - and `tml runs
<id>` views a finished run or attaches to one still running, read-only. A bare `tml` on an
interactive TTY now consults run history first: when an unfinished run for the current branch
exists, it offers resume / attach / fresh / list instead of silently starting over (a non-TTY/CI
run, `--plain`, or an explicit `--fresh`/`--resume` skips the gate). Runs record their PR URL,
finish time, failure summary, and owning process, and a run still marked `running` is classified by
liveness so a crash orphan reads as resumable rather than a phantom in progress.
