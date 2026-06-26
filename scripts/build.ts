#!/usr/bin/env bun
// Compile the tml CLI into a self-contained binary. The OpenTUI Solid renderer is authored in JSX
// (.tsx), so the bundler needs the Solid transform plugin - the plain `bun build` CLI can't load a
// plugin, so we drive Bun.build() here. Usage: `bun run scripts/build.ts [bun-target] [outfile]`,
// e.g. `bun run scripts/build.ts bun-linux-x64 dist/tml-linux-x64`. Defaults compile for the host.

import solidPlugin from "@opentui/solid/bun-plugin";

// A cross-compile target like "bun-linux-x64"; omitted (host target) for the local `bun run build`.
const compileTarget = process.argv[2];
const outfile = process.argv[3] ?? "dist/tml";

// tml runs inside arbitrary project repos. By default a compiled Bun binary auto-loads bunfig.toml
// and .env from its runtime cwd, so the host project's bun config would leak into tml - notably a
// `preload` it can't resolve (this repo's own `@opentui/solid/preload`), which aborts startup. tml
// reads only real shell env vars, so opt out of both autoloads to keep the binary hermetic.
const autoload = { autoloadBunfig: false, autoloadDotenv: false };

const result = await Bun.build({
  entrypoints: ["packages/cli/src/index.ts"],
  target: "bun",
  plugins: [solidPlugin],
  compile: compileTarget
    ? { target: compileTarget, outfile, ...autoload }
    : { outfile, ...autoload },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}${compileTarget ? ` (${compileTarget})` : ""}`);
