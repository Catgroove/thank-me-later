---
"@tml/core": minor
"@tml/github": major
"@tml/defaults": patch
"tml": minor
---

Rename the code-host provider concept to Git provider across the public API and config. The new names are `ctx.gitProvider`, `providers.gitProvider`, `Selection.gitProvider`, `registerGitProvider`, `GitProvider`, and `createGitHubProvider`.
