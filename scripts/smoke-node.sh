#!/usr/bin/env bash
# End-to-end smoke: cached node up -> deploy Counter -> verify ARMED (codeHash) -> call Get.
# Requires a synced node (`qinit node get` / `qinit up`). Exercises deploy arm-verification (#1).
set -euo pipefail
cd "$(dirname "$0")/.."
Q=./dist/qinit
strip() { sed 's/\x1b\[[0-9;]*[mGKHA]//g'; }

$Q node run --wait 150 2>&1 | strip | grep -q "ticking at" || { echo "✗ node not ticking"; exit 1; }
$Q deploy --contract fixtures/Counter.h 2>&1 | strip | grep -q "armed ✓" || { echo "✗ deploy did not arm"; $Q node stop >/dev/null 2>&1; exit 1; }
$Q call --fn 28 1 2>&1 | strip | grep -q "fn 28" || { echo "✗ call failed"; $Q node stop >/dev/null 2>&1; exit 1; }
echo "✓ node smoke PASSED (deploy armed + call)"
