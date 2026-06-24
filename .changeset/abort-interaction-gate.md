---
"@tml/core": patch
"tml": patch
---

Let ctrl-c abort a Run that is parked on a human gate. A Step waiting on `ctx.ask` or
`ctx.approveFindings` was previously unreachable by the abort signal: those responder Promises only
settle when the operator answers, so the drive loop never returned to its `signal.aborted` check and
the Run hung - pressing ctrl-c (or `y`) at the abort prompt did nothing. The engine now races the
gate's responder against the Run's signal and rejects with `AbortError` the moment it fires, so the
Run ends as cancelled, the same way an aborted `until`/agent does. Gates reached over any renderer
(TUI or plain) are now cancellable.
