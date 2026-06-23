---
"@tml/view": patch
---

Stop a Step's elapsed time from advancing while the Run is blocked on a human decision (an `ask`/`approval` gate). The presenter now tracks per-Step `waitedMs` and excludes it from the recorded `durationMs`; live elapsed in the TUI and the sealed timing in the terminal renderer freeze at the moment the gate opens. A review awaiting approval no longer shows a clock that climbs while the user deliberates.
