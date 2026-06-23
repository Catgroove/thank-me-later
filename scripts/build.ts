#!/usr/bin/env bun
// Compile the tml CLI into a self-contained binary. The OpenTUI Solid renderer is authored in JSX
// (.tsx), so the bundler needs the Solid transform plugin - the plain `bun build` CLI can't load a
// plugin, so we drive Bun.build() here. Usage: `bun run scripts/build.ts [bun-target] [outfile]`,
// e.g. `bun run scripts/build.ts bun-linux-x64 dist/tml-linux-x64`. Defaults compile for the host.

import solidPlugin from "@opentui/solid/bun-plugin";

// A cross-compile target like "bun-linux-x64"; omitted (host target) for the local `bun run build`.
const compileTarget = process.argv[2];
const outfile = process.argv[3] ?? "dist/tml";

const result = await Bun.build({
  entrypoints: ["packages/cli/src/index.ts"],
  target: "bun",
  plugins: [solidPlugin],
  compile: compileTarget ? { target: compileTarget, outfile } : { outfile },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}${compileTarget ? ` (${compileTarget})` : ""}`);
