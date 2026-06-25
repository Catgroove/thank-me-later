---
"@tml/core": minor
"@tml/defaults": minor
---

Cut review token cost by delegating context to the agent. The review step no longer inlines the branch diff into every pass - it hands the agent the base ref and the exact diff scope and lets it read the worktree. Round history fed to fresh agent prompts is now a compact, detail-free findings ledger instead of the full prior rounds, and the review preamble is trimmed to a tight instruction block.
