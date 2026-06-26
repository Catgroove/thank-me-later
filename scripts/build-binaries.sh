#!/usr/bin/env bash
# Cross-compile the tml CLI into self-contained binaries, one per supported platform.
# Bun cross-compiles from a single host, so the release runner builds every target here.
# Output names match what install.sh downloads: tml-<os>-<arch>.
set -euo pipefail

cd "$(dirname "$0")/.."

# OpenTUI ships its native core as per-platform optional dependencies; a plain `bun install`
# only fetches the host's. Cross-compiling a target embeds that target's native package, so
# every target's binary must be present first. `--os '*' --cpu '*'` fetches them all (lockfile
# unchanged, so --frozen-lockfile still holds).
bun install --frozen-lockfile --os '*' --cpu '*'

targets=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

mkdir -p dist
rm -f dist/tml-*
for t in "${targets[@]}"; do
  echo "building dist/tml-$t (bun-$t)"
  # The TUI renderer is JSX (.tsx); scripts/build.ts drives Bun.build() with the Solid transform
  # plugin, which the plain `bun build` CLI can't load.
  bun run scripts/build.ts "bun-$t" "dist/tml-$t"
done
