#!/bin/sh
# tml installer. Downloads the prebuilt binary for this OS/arch from GitHub Releases and
# drops it on your PATH. Usage:
#
#   curl -fsSL https://raw.githubusercontent.com/Catgroove/thank-me-later/master/install.sh | sh
#
# Knobs (environment variables):
#   TML_VERSION      pin a release tag (e.g. v0.1.0); default: the latest release
#   TML_INSTALL_DIR  where to install; default: $HOME/.local/bin
set -eu

REPO="Catgroove/thank-me-later"
INSTALL_DIR="${TML_INSTALL_DIR:-$HOME/.local/bin}"

err() {
  echo "tml install: $1" >&2
  exit 1
}

# Map `uname` to the asset suffix the release workflow produces (tml-<os>-<arch>).
os=$(uname -s)
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) err "unsupported OS \"$os\" (only macOS and Linux have prebuilt binaries)." ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) err "unsupported architecture \"$arch\" (expected x86_64 or arm64)." ;;
esac

asset="tml-${os}-${arch}"

if [ -n "${TML_VERSION:-}" ]; then
  url="https://github.com/${REPO}/releases/download/${TML_VERSION}/${asset}"
else
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
fi

command -v curl >/dev/null 2>&1 || err "curl is required but was not found."

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

echo "downloading ${asset}..."
curl -fsSL "$url" -o "$tmp" ||
  err "could not download $url — no release asset for ${os}/${arch}? (check ${TML_VERSION:-latest})"

chmod +x "$tmp"
mkdir -p "$INSTALL_DIR"
mv "$tmp" "$INSTALL_DIR/tml"
trap - EXIT

echo "Installed tml to $INSTALL_DIR/tml"

# Nudge the user if the install dir isn't on PATH, so `tml` resolves in a new shell.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: $INSTALL_DIR is not on your PATH. Add it, e.g.:"
     echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

echo "Run \`tml init\` in a repo to scaffold a tml.json, then \`tml ship\`."
