#!/usr/bin/env bash
# The changesets/action "publish" command. It runs on every push to master with no pending
# changesets, so it must be idempotent: a release only happens when the `tml` version has
# advanced past every existing release (i.e. just after a "Version Packages" PR merged).
#
# The binary's version is the `tml` package version; `updateInternalDependencies: patch` in
# .changeset/config.json means any @tml/* bump patch-bumps tml too, so the product version
# advances with any change. Requires GH_TOKEN (set by the workflow) for the gh CLI.
set -euo pipefail

cd "$(dirname "$0")/.."

version="$(bun -e 'console.log(require("./packages/cli/package.json").version)')"
tag="v$version"

if [ "$version" = "0.0.0" ]; then
  echo "package version is 0.0.0 — refusing to publish the bootstrap version"
  exit 0
fi

if gh release view "$tag" >/dev/null 2>&1; then
  echo "release $tag already exists — nothing to publish"
  exit 0
fi

echo "publishing $tag"
bash scripts/build-binaries.sh
gh release create "$tag" dist/tml-* --generate-notes --title "$tag"
