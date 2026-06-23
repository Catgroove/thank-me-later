---
"@tml/core": patch
---

Replay a resumed Step's artifacts and Round history into the view. When `tml ship` resumes a Run Journal and skips an already-completed Step, the engine now re-emits the durable facts (`artifact:written`, `round:recorded`) it loaded from the journal before marking the Step skipped. Previously a skipped Step rendered empty - the summary, artifacts, and Findings were persisted and rehydrated for execution but never turned into the presentation events the event-sourced view folds, so the TUI/CLI showed only "skipped" with no record of what the prior run did. The Step still reports `skipped`; it now carries its prior output.
