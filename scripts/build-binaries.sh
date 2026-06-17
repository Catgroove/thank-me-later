#!/usr/bin/env bash
# Cross-compile the tml CLI into self-contained binaries, one per supported platform.
# Bun cross-compiles from a single host, so the release runner builds every target here.
# Output names match what install.sh downloads: tml-<os>-<arch>.
set -euo pipefail

cd "$(dirname "$0")/.."

entry="packages/cli/src/index.ts"
targets=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

mkdir -p dist
for t in "${targets[@]}"; do
  echo "building dist/tml-$t (bun-$t)"
  bun build "$entry" --compile --target="bun-$t" --outfile "dist/tml-$t"
done
