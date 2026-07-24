#!/usr/bin/env bash
# Regression guard: the `bun --compile` binary must run wasm crypto (K12 + FourQ).
# The static-require k12 dedup is brittle — a lib bump can silently rebreak it in the compiled binary.
set -euo pipefail
cd "$(dirname "$0")/.."

bun run build:bin >/dev/null
strip() {
  sed 's/\x1b\[[0-9;]*[mGKHA]//g'
}

if ./dist/qinit smoke 2>&1 | strip | grep -q "valid identity"; then
  echo "✓ smoke: K12+FourQ ok in compiled binary"
else
  echo "✗ smoke: wasm crypto broken in compiled binary"
  exit 1
fi

# k12 must compute in the compiled binary's build (vs "(pending)"). Needs synced core headers.
if [ -f "$HOME/.cache/qinit/current.json" ] || [ -n "${QINIT_CORE:-}" ]; then
  out=$(./dist/qinit build --contract fixtures/Counter.h 2>&1 | strip)
  if echo "$out" | grep k12 | grep -qE "[0-9a-f]{16}"; then
    echo "✓ k12 computes in compiled build"
  else
    echo "✗ k12 (pending) in compiled binary"
    exit 1
  fi
else
  echo "… skip k12-build check (run 'qinit setup' first)"
fi
echo "compiled-crypto guard PASSED"
