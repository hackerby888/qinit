#!/bin/sh
# qinit installer — downloads the prebuilt binary for this OS/arch from the latest GitHub release.
#   curl -fsSL https://raw.githubusercontent.com/hackerby888/qinit/main/install.sh | sh
set -eu
REPO="hackerby888/qinit"
BIN_DIR="${QINIT_BIN:-$HOME/.local/bin}"

os=$(uname -s); arch=$(uname -m)
case "$os" in
  Linux) o=linux ;;
  Darwin) o=darwin ;;
  *) echo "qinit: unsupported OS '$os' (linux/darwin; windows: download qinit-windows-x64.exe manually)"; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) a=x64 ;;
  aarch64|arm64) a=arm64 ;;
  *) echo "qinit: unsupported arch '$arch'"; exit 1 ;;
esac

asset="qinit-$o-$a"
base="https://github.com/$REPO/releases/latest/download"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "qinit: downloading $asset …"
curl -fsSL "$base/$asset" -o "$tmp/qinit" || { echo "qinit: download failed ($base/$asset)"; exit 1; }

# Verify sha256 against SHA256SUMS if present.
if curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  want=$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}' || true)
  if [ -n "$want" ]; then
    got=$( (sha256sum "$tmp/qinit" 2>/dev/null || shasum -a 256 "$tmp/qinit") | awk '{print $1}')
    [ "$want" = "$got" ] || { echo "qinit: sha256 mismatch (want $want got $got)"; exit 1; }
    echo "qinit: sha256 ok"
  fi
fi

mkdir -p "$BIN_DIR"
chmod +x "$tmp/qinit"
mv "$tmp/qinit" "$BIN_DIR/qinit"
echo "qinit: installed -> $BIN_DIR/qinit"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "qinit: note — $BIN_DIR not on PATH; add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
"$BIN_DIR/qinit" version 2>/dev/null || true
