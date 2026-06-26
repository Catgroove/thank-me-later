---
"tml": patch
---

Make the compiled binary hermetic. A standalone Bun executable auto-loads `bunfig.toml` and `.env` from its runtime cwd, so running `tml` inside a project with a `bunfig.toml` `preload` (such as this repo's `@opentui/solid/preload`) aborted startup with `preload not found`. The build now opts out of both autoloads, so the host project's bun config no longer leaks into tml.
