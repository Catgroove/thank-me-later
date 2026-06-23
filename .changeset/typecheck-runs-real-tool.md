---
"@tml/defaults": patch
---

Make the typecheck step run the real type checker instead of simulating it. The prompt
previously forbade invoking the compiler and asked the agent to verify types by model-backed
source inspection, which crawled the whole diff and took minutes. It now discovers the
project's type-check command and runs it - fast and authoritative - matching how the test
step already works. Format and lint remain source-inspection checks.
