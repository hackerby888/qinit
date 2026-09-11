#!/usr/bin/env bash
# Build core's WAMR contract-test binary — the third oracle this campaign uses to check a contract
# against the runtime core actually runs, rather than against the other backend.
#
# This exists because the binary is NOT part of any repo and does not survive a container restart,
# and because none of the four flags it needs are defaults. Round 6 lost an afternoon rediscovering
# them; this script is so the next restart does not.
#
#   nasm            CompilerSetup.cmake requires it even with BUILD_BINARY=OFF
#   LITE_WASM_SC    the target only exists under it
#   TESTNET         + TESTNET_LITE_RAM — LITE_WASM_SC refuses to configure without both
#
# core-lite is treated as a scratch build tree: this script configures and builds in it, and never
# commits, branches or pushes there.
#
# Idempotent: re-running skips the build when the binary is already newer than core's wasm test sources.
#
# Usage:  QINIT_CORE=/path/to/core-lite scripts/solidity-port/build-wamr-oracle.sh [--force]
# Then:   export QINIT_WAMR_GTEST=$(QINIT_CORE=... scripts/solidity-port/build-wamr-oracle.sh --path)
set -euo pipefail

CORE="${QINIT_CORE:-/home/user/core-lite}"
BINARY="$CORE/build-wasm/test/qubic_wasm_tests"
SHIM="$CORE/test/wasm_k12_shim.cpp"
FORCE=0

case "${1:-}" in
    --path) echo "$BINARY"; exit 0 ;;
    --force) FORCE=1 ;;
esac

if [[ ! -d "$CORE" ]]; then
    echo "error: core-lite not found at $CORE — set QINIT_CORE" >&2
    exit 1
fi

if ! command -v nasm >/dev/null 2>&1; then
    echo "error: nasm is required (cmake/CompilerSetup.cmake looks for it even with BUILD_BINARY=OFF)" >&2
    echo "       apt-get install -y nasm" >&2
    exit 1
fi

# The parity shim lives in core-lite (test/wasm_k12_shim.cpp and the lhost registrations beside it).
# Without it the gtest registers five natives and any contract calling a host function traps for want
# of an import rather than because anything is wrong — 152 of 770 runs in round 6.
if [[ ! -f "$SHIM" ]]; then
    echo "error: $CORE carries no test/wasm_k12_shim.cpp — the parity shim is missing" >&2
    echo "       update core-lite to a revision that has it; this script will not build the narrow" >&2
    echo "       five-native oracle and report it as widened." >&2
    exit 1
fi

# A binary older than core's wasm test sources is not the oracle this script promises.
if [[ -x "$BINARY" && "$FORCE" -eq 0 ]] && [[ "$BINARY" -nt "$SHIM" ]]; then
    echo "wamr oracle already built: $BINARY"
    exit 0
fi

echo "configuring $CORE/build-wasm ..."
cmake -S "$CORE" -B "$CORE/build-wasm" -G Ninja \
    -DBUILD_TESTS=ON \
    -DLITE_WASM_SC=ON \
    -DTESTNET=ON \
    -DTESTNET_LITE_RAM=ON \
    -DBUILD_BINARY=OFF \
    -DUSE_SANITIZER=OFF \
    -DANT_WALKER=OFF \
    -DCMAKE_BUILD_TYPE=Release

echo "building qubic_wasm_tests (fetches WAMR at its pinned SHA on a cold build) ..."
cmake --build "$CORE/build-wasm" --target qubic_wasm_tests -j"$(nproc)"

if [[ ! -x "$BINARY" ]]; then
    echo "error: build reported success but $BINARY is missing" >&2
    exit 1
fi

echo
echo "wamr oracle built: $BINARY"
echo "export QINIT_WAMR_GTEST=$BINARY"
echo
echo "Calibrate it before trusting any result — an oracle that has not been checked against a known"
echo "answer is not an oracle, and this one has just been modified:"
echo "  bun test packages/cli/tests/integration/cross-host.test.ts    # expect 8 pass"
