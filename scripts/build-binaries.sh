#!/usr/bin/env bash
# Cross-compile the tml CLI into self-contained binaries, one per supported platform.
# Bun cross-compiles from a single host, so the release runner builds every target here.
# Output names match what install.sh downloads: tml-<os>-<arch>.
set -euo pipefail

cd "$(dirname "$0")/.."

targets=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

mkdir -p dist
rm -f dist/tml-*
for t in "${targets[@]}"; do
  echo "building dist/tml-$t (bun-$t)"
  # The TUI renderer is JSX (.tsx); scripts/build.ts drives Bun.build() with the Solid transform
  # plugin, which the plain `bun build` CLI can't load.
  bun run scripts/build.ts "bun-$t" "dist/tml-$t"
done
