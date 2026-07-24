#!/bin/sh
# qinit installer — downloads the prebuilt binary for this OS/arch from the newest qinit-cli release.
#   curl -fsSL https://raw.githubusercontent.com/hackerby888/qinit/main/install.sh | sh
set -eu
REPO="hackerby888/qinit"
BIN_DIR="${QINIT_BIN:-$HOME/.local/bin}"
TOTAL_STEPS=5

task() {
  printf '\n[%s/%s] %s\n' "$1" "$TOTAL_STEPS" "$2"
}

status() {
  printf '      %s\n' "$1"
}

download_cli() {
  if [ -t 2 ]; then
    curl -fL --progress-bar "$1" -o "$2"
  else
    curl -fsSL "$1" -o "$2"
  fi
}

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) o=linux ;;
  Darwin) o=darwin ;;
  *)
    echo "qinit: unsupported OS '$os' (linux/darwin; windows: download qinit-windows-x64.exe manually)"
    exit 1
    ;;
esac
case "$arch" in
  x86_64|amd64) a=x64 ;;
  aarch64|arm64) a=arm64 ;;
  *)
    echo "qinit: unsupported arch '$arch'"
    exit 1
    ;;
esac

asset="qinit-$o-$a"
# Other release tracks can claim GitHub's "latest" release.
# Resolve the newest qinit-cli tag explicitly instead.
task 1 "Resolving latest qinit release"
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases" 2>/dev/null \
  | grep -oE '"tag_name": *"qinit-cli-[^"]+"' | head -n1 | sed -E 's/.*"(qinit-cli-[^"]+)".*/\1/')
[ -n "$TAG" ] || {
  echo "qinit: could not resolve a qinit-cli release tag (GitHub API unreachable or rate-limited)"
  exit 1
}
status "found $TAG"
base="https://github.com/$REPO/releases/download/$TAG"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

task 2 "Downloading $asset"
download_cli "$base/$asset" "$tmp/qinit" || {
  echo "qinit: download failed ($base/$asset)"
  exit 1
}
status "downloaded"

# Verify sha256 against SHA256SUMS if present.
task 3 "Verifying checksum"
if curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  want=$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}' || true)
  if [ -n "$want" ]; then
    got=$( (sha256sum "$tmp/qinit" 2>/dev/null || shasum -a 256 "$tmp/qinit") | awk '{print $1}')
    [ "$want" = "$got" ] || {
      echo "qinit: sha256 mismatch (want $want got $got)"
      exit 1
    }
    status "sha256 verified"
  else
    status "checksum entry not published; skipped"
  fi
else
  status "checksum file not published; skipped"
fi

task 4 "Installing qinit"
mkdir -p "$BIN_DIR"
chmod +x "$tmp/qinit"
mv "$tmp/qinit" "$BIN_DIR/qinit"
dest="$BIN_DIR/qinit"
status "installed -> $dest"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "qinit: note — $BIN_DIR not on PATH; add:  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

task 5 "Preparing development tools"
if ! "$dest" setup; then
  echo "qinit: setup failed; the CLI remains installed at $dest"
  printf 'qinit: retry: "%s" setup\n' "$dest"
  exit 1
fi
status "development tools ready"

"$dest" version 2>/dev/null || true
