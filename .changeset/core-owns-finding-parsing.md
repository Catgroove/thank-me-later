---
"@tml/core": patch
"@tml/defaults": patch
---

Move the agent-findings validator into `@tml/core`, beside `makeFinding` and `findingId` where Findings are minted. `parseAgentFindingsOutput` (and `ParseAgentFindingsOptions`) are now part of core's public surface; the check and review steps import them from `@tml/core` and the standalone `findings` module in `@tml/defaults` is deleted. Finding validity - the severity and action enum tables - no longer leaks out of core.
