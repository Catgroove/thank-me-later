---
"tml": minor
---

Add self-update. `tml update` moves the installed binary to the latest GitHub release by re-running the curl installer pinned to that version (`--check` reports without installing), and `tml --version` / `-V` prints the installed version. After a command, when a newer release exists, the CLI prints a one-line update notice. The check runs in the background and is cached for a day, so it adds no latency, and it is suppressed in CI, in pipes, and via `NO_UPDATE_NOTIFIER` / `TML_NO_UPDATE_NOTIFIER`.
